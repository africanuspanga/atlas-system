-- ATLAS migration 0013 — platform layer: plans, entitlements, enforcement
-- data, platform audit (CTO §7; closes AUD-016's enforcement gap).
--
-- Design: profiles.platform_role (existing, distinct from tenant membership)
-- is the platform-staff identity. Plans carry limits in plans.limits jsonb;
-- app.tenant_entitlements() resolves plan + subscription + overrides into one
-- document the API guard reads on every request. Platform-wide actions land
-- in platform_audit_logs (no tenant scope) AND mirror into the target
-- tenant's audit_logs so schools see what was done to them.

-- ---------------------------------------------------------------------------
-- Seed plans (idempotent). Limits: null = unlimited.
-- ---------------------------------------------------------------------------
insert into public.plans (key, name, description, monthly_price_tzs, annual_price_tzs, limits)
values
  ('trial',  'Trial',  '30-day evaluation',                    0,       0,
   '{"students": 300, "staff": 20, "campuses": 1, "smsMonthly": 200}'),
  ('msingi', 'Msingi', 'Single-campus primary/secondary',      150000,  1500000,
   '{"students": 800, "staff": 60, "campuses": 1, "smsMonthly": 2000}'),
  ('kati',   'Kati',   'Growing schools, up to three campuses', 350000, 3500000,
   '{"students": 2000, "staff": 200, "campuses": 3, "smsMonthly": 10000}'),
  ('juu',    'Juu',    'Large multi-campus institutions',       800000, 8000000,
   '{"students": null, "staff": null, "campuses": null, "smsMonthly": 50000}')
on conflict (key) do nothing;

-- Every existing tenant gets a trial subscription so enforcement has
-- something to evaluate (30 days from this migration).
insert into public.subscriptions (tenant_id, plan_id, status, trial_ends_at)
select t.id, p.id, 'trialing', now() + interval '30 days'
from public.tenants t
cross join (select id from public.plans where key = 'trial') p
where not exists (select 1 from public.subscriptions s where s.tenant_id = t.id);

-- ---------------------------------------------------------------------------
-- Platform audit log — actions BY platform staff, not tenant members.
-- No RLS policies: service-role only.
-- ---------------------------------------------------------------------------
create table public.platform_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.profiles(id),
  action text not null,
  tenant_id uuid references public.tenants(id),
  entity_type text,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index platform_audit_logs_idx on public.platform_audit_logs (created_at desc);
alter table public.platform_audit_logs enable row level security;

-- ---------------------------------------------------------------------------
-- Entitlement resolution: one call returns everything the API guard needs.
-- Missing subscription = most restrictive posture (trial limits, expired).
-- ---------------------------------------------------------------------------
create or replace function app.tenant_entitlements(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
  v_sub record;
  v_limits jsonb;
  v_features jsonb;
begin
  select * into v_tenant from public.tenants where id = p_tenant_id;
  if v_tenant.id is null then
    raise exception 'TENANT_NOT_FOUND';
  end if;

  select s.status, s.trial_ends_at, s.current_period_end, p.key as plan_key,
         p.limits, s.id as subscription_id
    into v_sub
  from public.subscriptions s
  join public.plans p on p.id = s.plan_id
  where s.tenant_id = p_tenant_id
  order by s.created_at desc
  limit 1;

  v_limits := coalesce(v_sub.limits,
    (select limits from public.plans where key = 'trial'));

  -- Feature map: plan features overlaid by tenant overrides.
  select coalesce(jsonb_object_agg(f.feature_key, f.enabled), '{}'::jsonb)
    into v_features
  from (
    select pf.feature_key, pf.enabled
    from public.plan_features pf
    join public.plans p on p.id = pf.plan_id
    where p.key = coalesce(v_sub.plan_key, 'trial')
    union all
    select tf.feature_key, tf.enabled
    from public.tenant_features tf
    where tf.tenant_id = p_tenant_id
  ) f;

  return jsonb_build_object(
    'tenantStatus', v_tenant.status,
    'planKey', coalesce(v_sub.plan_key, 'trial'),
    'subscriptionStatus', coalesce(v_sub.status, 'expired'),
    'trialEndsAt', v_sub.trial_ends_at,
    'currentPeriodEnd', v_sub.current_period_end,
    'limits', v_limits,
    'features', v_features,
    'usage', jsonb_build_object(
      'students', (select count(*) from public.students
                   where tenant_id = p_tenant_id and status = 'active'),
      'staff', (select count(*) from public.tenant_memberships
                where tenant_id = p_tenant_id and status = 'active'),
      'campuses', (select count(*) from public.campuses
                   where tenant_id = p_tenant_id and status = 'active'),
      'smsThisMonth', (select count(*) from public.notification_outbox
                       where tenant_id = p_tenant_id and status = 'sent'
                         and sent_at >= date_trunc('month', now()))
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform overview: cross-tenant aggregates only — counts and sums, no PII.
-- ---------------------------------------------------------------------------
create or replace function app.platform_overview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'tenantsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*)::int as n from public.tenants group by status) x
    ),
    'subscriptionsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*)::int as n from public.subscriptions group by status) x
    ),
    'totals', jsonb_build_object(
      'tenants', (select count(*) from public.tenants),
      'campuses', (select count(*) from public.campuses),
      'students', (select count(*) from public.students where status = 'active'),
      'staff', (select count(*) from public.tenant_memberships where status = 'active'),
      'guardians', (select count(*) from public.guardians),
      'linkedParents', (select count(*) from public.guardians where user_id is not null)
    ),
    'monthlyRecurringRevenueTzs', (
      select coalesce(sum(p.monthly_price_tzs), 0)
      from public.subscriptions s join public.plans p on p.id = s.plan_id
      where s.status = 'active'
    ),
    'smsSentThisMonth', (
      select count(*) from public.notification_outbox
      where status = 'sent' and sent_at >= date_trunc('month', now())
    ),
    'smsFailedTotal', (
      select count(*) from public.notification_outbox where status = 'failed'
    ),
    'importJobsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*)::int as n from public.import_jobs group by status) x
    ),
    'reportJobsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*)::int as n from public.report_jobs group by status) x
    ),
    'generatedAt', now()
  );
$$;

-- Public wrappers — service role only.
create or replace function public.tenant_entitlements(p_tenant_id uuid)
returns jsonb language sql stable security definer set search_path = public
as $$ select app.tenant_entitlements(p_tenant_id); $$;
create or replace function public.platform_overview()
returns jsonb language sql stable security definer set search_path = public
as $$ select app.platform_overview(); $$;

revoke execute on function app.tenant_entitlements(uuid) from public, anon, authenticated;
revoke execute on function app.platform_overview() from public, anon, authenticated;
revoke execute on function public.tenant_entitlements(uuid) from public, anon, authenticated;
revoke execute on function public.platform_overview() from public, anon, authenticated;
grant execute on function public.tenant_entitlements(uuid) to service_role;
grant execute on function public.platform_overview() to service_role;
