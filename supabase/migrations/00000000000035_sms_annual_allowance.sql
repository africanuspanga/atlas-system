-- 0035 — SMS allowance: annual, plus purchasable bundles.
--
-- WHY: plans carried `smsMonthly` and app.claim_notification counted sent rows
-- since the start of the calendar month. The product is sold as 20,000 SMS
-- PER YEAR with the annual subscription, and schools can buy more. A school
-- sending term-opening fee reminders would hit a monthly ceiling it was never
-- sold, and a school that bought extra had nowhere to put them.
--
-- WHAT CHANGES:
--   * `plans.limits.smsIncludedYear` replaces `smsMonthly` as the allowance the
--     subscription grants. `smsMonthly` is left in place and simply ignored, so
--     nothing breaks mid-flight — remove it in a later, separate migration once
--     no environment reads it.
--   * `tenant_sms_balance` records purchased bundles and the usage window.
--   * app.claim_notification spends the included allowance first, then any
--     purchased balance, and blocks at zero rather than failing silently.
--
-- The counter is windowed on the subscription period, not the calendar year:
-- a school that starts in May should get its reset in May.

begin;

create table if not exists public.tenant_sms_balance (
  tenant_id uuid primary key references public.tenants(id),

  -- Start of the current allowance window. Rolled forward on renewal.
  period_start date not null default (now() at time zone 'Africa/Dar_es_Salaam')::date,

  -- Bundles bought on top of the included allowance. Never auto-decremented
  -- below zero; the claim function refuses instead.
  purchased_sms integer not null default 0 check (purchased_sms >= 0),

  updated_at timestamptz not null default now()
);

alter table public.tenant_sms_balance enable row level security;

-- Members may read their own school's balance so the admin UI can show the
-- used/remaining counter and the 80% warning. Writes are API-only.
drop policy if exists tenant_sms_balance_member_read on public.tenant_sms_balance;
create policy tenant_sms_balance_member_read on public.tenant_sms_balance
  for select using (app.is_tenant_member(tenant_id));

create trigger tenant_sms_balance_updated_at
  before update on public.tenant_sms_balance
  for each row execute function app.set_updated_at();

comment on table public.tenant_sms_balance is
  'Purchased SMS bundles and the current allowance window. Included allowance comes from the plan (limits.smsIncludedYear).';

-- Every existing plan keeps a sane annual figure. The founding offer is 20,000;
-- plans that carried a monthly number get twelve times it so no school is
-- suddenly worse off than it was yesterday.
update public.plans
set limits = jsonb_set(
      limits,
      '{smsIncludedYear}',
      to_jsonb(
        coalesce(
          (limits->>'smsIncludedYear')::int,
          (limits->>'smsMonthly')::int * 12,
          20000
        )
      ),
      true
    )
where limits ? 'smsMonthly' or not (limits ? 'smsIncludedYear');

/**
 * Usage in the current allowance window, and what remains.
 * Exposed so the admin UI and the 80% warning read the same numbers the
 * drainer enforces — a counter that disagrees with the gate is worse than none.
 */
create or replace function app.tenant_sms_usage(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app
as $$
declare
  v_included integer;
  v_purchased integer;
  v_period_start date;
  v_used integer;
begin
  v_included := (app.tenant_entitlements(p_tenant_id)->'limits'->>'smsIncludedYear')::int;

  select b.purchased_sms, b.period_start
    into v_purchased, v_period_start
  from public.tenant_sms_balance b
  where b.tenant_id = p_tenant_id;

  v_purchased := coalesce(v_purchased, 0);
  v_period_start := coalesce(
    v_period_start,
    (now() at time zone 'Africa/Dar_es_Salaam')::date - interval '1 year'
  );

  select count(*) into v_used
  from public.notification_outbox
  where tenant_id = p_tenant_id
    and status = 'sent'
    and sent_at >= (v_period_start::timestamp at time zone 'Africa/Dar_es_Salaam');

  return jsonb_build_object(
    'included', v_included,
    'purchased', v_purchased,
    'used', v_used,
    'remaining', case
      when v_included is null then null
      else greatest(0, v_included + v_purchased - v_used)
    end,
    'periodStart', v_period_start
  );
end;
$$;

revoke all on function app.tenant_sms_usage(uuid) from public, anon, authenticated;

-- PostgREST only exposes `public`, so members reach it through a wrapper.
create or replace function public.tenant_sms_usage(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app
as $$
begin
  if not app.is_tenant_member(p_tenant_id) then
    raise exception 'SMS_USAGE_FORBIDDEN';
  end if;
  return app.tenant_sms_usage(p_tenant_id);
end;
$$;

revoke all on function public.tenant_sms_usage(uuid) from public, anon;
grant execute on function public.tenant_sms_usage(uuid) to authenticated;

/**
 * Claim gate: spend the included annual allowance first, then purchased
 * bundles. Blocks at zero rather than letting a fee reminder disappear.
 *
 * Replaces the monthly window from 0031. The advisory lock is retained so
 * multiple worker replicas cannot race past the allowance.
 */
create or replace function app.claim_notification(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  v_row public.notification_outbox%rowtype;
  v_usage jsonb;
  v_remaining integer;
begin
  select o.* into v_row
  from public.notification_outbox o
  join public.tenants t on t.id = o.tenant_id
  where o.id = p_id
    and o.status = 'pending'
    and o.next_attempt_at <= now()
    and t.status in ('configuration', 'data_review', 'training', 'live')
  for update of o;

  if v_row.id is null then
    return jsonb_build_object('status', 'unavailable');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_row.tenant_id::text, 0));

  v_usage := app.tenant_sms_usage(v_row.tenant_id);
  v_remaining := (v_usage->>'remaining')::int;

  -- A null allowance means the plan does not cap SMS at all.
  if v_remaining is not null and v_remaining <= 0 then
    update public.notification_outbox
    set status = 'failed', last_error = 'SMS_ALLOWANCE_EXHAUSTED'
    where id = v_row.id;
    return jsonb_build_object('status', 'limit');
  end if;

  update public.notification_outbox
  set status = 'sending', attempts = attempts + 1, claimed_at = now(),
      last_error = null
  where id = v_row.id;

  -- Return shape is unchanged from 0031 — the drainer reads these keys.
  return jsonb_build_object(
    'status', 'claimed', 'id', v_row.id, 'tenantId', v_row.tenant_id,
    'recipient', v_row.recipient, 'template', v_row.template,
    'payload', v_row.payload, 'attempts', v_row.attempts + 1
  );
end;
$$;

revoke execute on function app.claim_notification(uuid) from public, anon, authenticated;
-- public.claim_notification (service-role only) is unchanged and still wraps this.

commit;
