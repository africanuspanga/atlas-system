-- ATLAS migration 0033 — make the owner overview describe the current
-- operating portfolio. Archived schools and historical subscription rows must
-- not inflate headcounts, MRR, delivery totals, or job-failure indicators.

create or replace function app.platform_overview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with operational_tenants as (
    select id, status
    from public.tenants
    where status <> 'archived'
  ),
  latest_sub as (
    select distinct on (s.tenant_id)
           s.tenant_id, s.status, s.plan_id
    from public.subscriptions s
    join operational_tenants t on t.id = s.tenant_id
    order by s.tenant_id, s.created_at desc
  ),
  current_sub as (
    select t.id as tenant_id, ls.status, p.monthly_price_tzs
    from operational_tenants t
    left join latest_sub ls on ls.tenant_id = t.id
    left join public.plans p on p.id = ls.plan_id
  )
  select jsonb_build_object(
    'tenantsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (
        select status, count(*)::int as n
        from public.tenants
        group by status
      ) x
    ),
    'subscriptionsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (
        select coalesce(status, 'none') as status, count(*)::int as n
        from current_sub
        group by coalesce(status, 'none')
      ) x
    ),
    'totals', jsonb_build_object(
      'tenants', (select count(*) from operational_tenants),
      'campuses', (
        select count(*)
        from public.campuses c
        join operational_tenants t on t.id = c.tenant_id
      ),
      'students', (
        select count(*)
        from public.students s
        join operational_tenants t on t.id = s.tenant_id
        where s.status = 'active'
      ),
      'staff', (
        select count(*)
        from public.tenant_memberships m
        join operational_tenants t on t.id = m.tenant_id
        where m.status = 'active'
      ),
      'guardians', (
        select count(*)
        from public.guardians g
        join operational_tenants t on t.id = g.tenant_id
      ),
      'linkedParents', (
        select count(*)
        from public.guardians g
        join operational_tenants t on t.id = g.tenant_id
        where g.user_id is not null
      )
    ),
    'monthlyRecurringRevenueTzs', (
      select coalesce(sum(monthly_price_tzs), 0)
      from current_sub
      where status = 'active'
    ),
    'smsSentThisMonth', (
      select count(*)
      from public.notification_outbox o
      join operational_tenants t on t.id = o.tenant_id
      where o.status = 'sent'
        and o.sent_at >= date_trunc('month', now())
    ),
    'smsFailedTotal', (
      select count(*)
      from public.notification_outbox o
      join operational_tenants t on t.id = o.tenant_id
      where o.status = 'failed'
    ),
    'importJobsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (
        select j.status, count(*)::int as n
        from public.import_jobs j
        join operational_tenants t on t.id = j.tenant_id
        group by j.status
      ) x
    ),
    'reportJobsByStatus', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
      from (
        select j.status, count(*)::int as n
        from public.report_jobs j
        join operational_tenants t on t.id = j.tenant_id
        group by j.status
      ) x
    ),
    'generatedAt', now()
  );
$$;

-- The public wrapper and grants were created in migration 0013. Reassert the
-- narrow execution boundary so future grant changes cannot expose the RPC.
revoke execute on function app.platform_overview() from public, anon, authenticated;
revoke execute on function public.platform_overview() from public, anon, authenticated;
grant execute on function public.platform_overview() to service_role;
