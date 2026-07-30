-- ATLAS migration 0024 — platform metrics for the super dashboard (platform
-- staff console): revenue/MRR, per-tenant health, and unit costs.
--
-- Design: pure read-only aggregates computed from existing tables — no new
-- tables. Like migration 0013's platform functions, these aggregate ACROSS
-- tenants and must never be member-readable: security-definer app.* functions
-- with service-role-only public wrappers (PostgREST exposes only public),
-- and the API's PlatformGuard (profiles.platform_role) authorizes callers.
-- "Latest subscription" per tenant follows app.tenant_entitlements():
-- the most recent row by created_at.

-- ---------------------------------------------------------------------------
-- Revenue: per-plan tenant counts + MRR estimate (active subs × monthly
-- price), subscription status breakdown, trials expiring within 14 days,
-- and the tenant status pipeline.
-- ---------------------------------------------------------------------------
create or replace function app.platform_revenue()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with latest_sub as (
    select distinct on (s.tenant_id)
           s.tenant_id, s.status, s.trial_ends_at, s.plan_id
    from public.subscriptions s
    order by s.tenant_id, s.created_at desc
  ),
  scoped as (
    -- Non-archived tenants with their current plan; archived tenants are
    -- test debris / churned and excluded from revenue math.
    select t.id as tenant_id, t.name, ls.status as sub_status,
           ls.trial_ends_at, p.key as plan_key, p.name as plan_name,
           p.monthly_price_tzs
    from public.tenants t
    left join latest_sub ls on ls.tenant_id = t.id
    left join public.plans p on p.id = ls.plan_id
    where t.status <> 'archived'
  )
  select jsonb_build_object(
    'perPlan', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'planKey', x.plan_key,
               'planName', x.plan_name,
               'monthlyPriceTzs', x.monthly_price_tzs,
               'tenants', x.tenants,
               'payingTenants', x.paying_tenants,
               'mrrTzs', x.mrr_tzs
             ) order by x.monthly_price_tzs nulls first, x.plan_key), '[]'::jsonb)
      from (
        select coalesce(s.plan_key, 'none') as plan_key,
               coalesce(s.plan_name, 'No subscription') as plan_name,
               s.monthly_price_tzs,
               count(*)::int as tenants,
               (count(*) filter (where s.sub_status = 'active'))::int as paying_tenants,
               coalesce(sum(s.monthly_price_tzs) filter (where s.sub_status = 'active'), 0) as mrr_tzs
        from scoped s
        group by s.plan_key, s.plan_name, s.monthly_price_tzs
      ) x
    ),
    'mrrTzs', (
      select coalesce(sum(monthly_price_tzs) filter (where sub_status = 'active'), 0)
      from scoped
    ),
    'payingTenants', (
      select (count(*) filter (where sub_status = 'active'))::int from scoped
    ),
    'subscriptionsByStatus', (
      select coalesce(jsonb_object_agg(coalesce(sub_status, 'none'), n), '{}'::jsonb)
      from (select sub_status, count(*)::int as n from scoped group by sub_status) y
    ),
    'trialsExpiringSoon', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'tenantId', tenant_id,
               'tenantName', name,
               'trialEndsAt', trial_ends_at
             ) order by trial_ends_at), '[]'::jsonb)
      from scoped
      where sub_status = 'trialing'
        and trial_ends_at between now() and now() + interval '14 days'
    ),
    'tenantsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (select status, count(*)::int as n from public.tenants group by status) z
    ),
    'generatedAt', now()
  );
$$;

-- ---------------------------------------------------------------------------
-- Health: per non-archived tenant, headcounts + last-7-days activity across
-- the four "school is alive" signals, and a bucket computed in SQL:
--   active  — activity within the last 3 days
--   quiet   — 4–14 days
--   silent  — > 14 days or never (null last_activity_at)
-- Ordered silent-first so the "call them" list is on top.
-- ---------------------------------------------------------------------------
create or replace function app.platform_health()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with latest_sub as (
    select distinct on (s.tenant_id) s.tenant_id, s.plan_id
    from public.subscriptions s
    order by s.tenant_id, s.created_at desc
  ),
  base as (
    select t.id, t.name, t.status, p.key as plan_key,
      (select count(*)::int from public.students st
        where st.tenant_id = t.id and st.status = 'active') as students,
      (select count(*)::int from public.tenant_memberships m
        where m.tenant_id = t.id and m.status = 'active') as staff,
      (select count(*)::int from public.attendance_sessions a
        where a.tenant_id = t.id
          and a.created_at >= now() - interval '7 days') as attendance_7d,
      (select count(*)::int from public.assessment_scores sc
        where sc.tenant_id = t.id
          and sc.created_at >= now() - interval '7 days') as scores_7d,
      (select count(*)::int from public.payments pay
        where pay.tenant_id = t.id
          and pay.created_at >= now() - interval '7 days') as payments_7d,
      (select count(*)::int from public.ai_messages am
        where am.tenant_id = t.id
          and am.created_at >= now() - interval '7 days') as ai_messages_7d,
      greatest(
        (select max(a.created_at) from public.attendance_sessions a where a.tenant_id = t.id),
        (select max(sc.created_at) from public.assessment_scores sc where sc.tenant_id = t.id),
        (select max(pay.created_at) from public.payments pay where pay.tenant_id = t.id),
        (select max(am.created_at) from public.ai_messages am where am.tenant_id = t.id)
      ) as last_activity_at
    from public.tenants t
    left join latest_sub ls on ls.tenant_id = t.id
    left join public.plans p on p.id = ls.plan_id
    where t.status <> 'archived'
  ),
  bucketed as (
    select b.*,
      case
        when b.last_activity_at >= now() - interval '3 days' then 'active'
        when b.last_activity_at >= now() - interval '14 days' then 'quiet'
        else 'silent'  -- includes never (null last_activity_at)
      end as health
    from base b
  )
  select jsonb_build_object(
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenantId', id,
        'name', name,
        'status', status,
        'planKey', plan_key,
        'students', students,
        'staff', staff,
        'attendanceSessions7d', attendance_7d,
        'assessmentScores7d', scores_7d,
        'payments7d', payments_7d,
        'aiMessages7d', ai_messages_7d,
        'lastActivityAt', last_activity_at,
        'health', health
      ) order by case health when 'silent' then 0 when 'quiet' then 1 else 2 end,
                 last_activity_at asc nulls first,
                 name)
      from bucketed
    ), '[]'::jsonb),
    'generatedAt', now()
  );
$$;

-- ---------------------------------------------------------------------------
-- Unit costs: per non-archived tenant over [p_from, p_to] (inclusive dates):
-- SMS queued (notification_outbox rows created in range — cost is incurred
-- on send attempts regardless of final status), AI requests + total tokens
-- (ai_usage_records), and the plan's monthly price for comparison.
-- ---------------------------------------------------------------------------
create or replace function app.platform_unit_costs(p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with latest_sub as (
    select distinct on (s.tenant_id) s.tenant_id, s.plan_id
    from public.subscriptions s
    order by s.tenant_id, s.created_at desc
  ),
  base as (
    select t.id, t.name, t.status, p.key as plan_key, p.monthly_price_tzs,
      (select count(*)::int from public.notification_outbox o
        where o.tenant_id = t.id
          and o.created_at >= p_from and o.created_at < p_to + 1) as sms_queued,
      (select count(*)::int from public.ai_usage_records u
        where u.tenant_id = t.id
          and u.created_at >= p_from and u.created_at < p_to + 1) as ai_requests,
      (select coalesce(sum(u.prompt_tokens + u.completion_tokens), 0)::bigint
        from public.ai_usage_records u
        where u.tenant_id = t.id
          and u.created_at >= p_from and u.created_at < p_to + 1) as ai_tokens
    from public.tenants t
    left join latest_sub ls on ls.tenant_id = t.id
    left join public.plans p on p.id = ls.plan_id
    where t.status <> 'archived'
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'tenants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenantId', id,
        'name', name,
        'status', status,
        'planKey', plan_key,
        'planMonthlyPriceTzs', monthly_price_tzs,
        'smsQueued', sms_queued,
        'aiRequests', ai_requests,
        'aiTokens', ai_tokens
      ) order by sms_queued + ai_requests desc, name)
      from base
    ), '[]'::jsonb),
    'generatedAt', now()
  );
$$;

-- Public wrappers — service role only (the API's PlatformGuard fronts these).
create or replace function public.platform_revenue()
returns jsonb language sql stable security definer set search_path = public
as $$ select app.platform_revenue(); $$;
create or replace function public.platform_health()
returns jsonb language sql stable security definer set search_path = public
as $$ select app.platform_health(); $$;
create or replace function public.platform_unit_costs(p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = public
as $$ select app.platform_unit_costs(p_from, p_to); $$;

revoke execute on function app.platform_revenue() from public, anon, authenticated;
revoke execute on function app.platform_health() from public, anon, authenticated;
revoke execute on function app.platform_unit_costs(date, date) from public, anon, authenticated;
revoke execute on function public.platform_revenue() from public, anon, authenticated;
revoke execute on function public.platform_health() from public, anon, authenticated;
revoke execute on function public.platform_unit_costs(date, date) from public, anon, authenticated;
grant execute on function public.platform_revenue() to service_role;
grant execute on function public.platform_health() to service_role;
grant execute on function public.platform_unit_costs(date, date) to service_role;
