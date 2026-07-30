-- ATLAS migration 0020 — transport (usafiri) module.
--
-- School bus routes with ordered stops (vituo) and per-route fees. Day
-- students are assigned to one route (optionally a specific stop) per
-- academic year; re-assignment deactivates the previous assignment. Writes
-- go through app.assign_transport only.
--
-- NOTE (v1): transport_routes.fee_amount is INFORMATIONAL ONLY — it is never
-- auto-invoiced. Billing a student for transport stays in the finance module
-- (invoices/ledger), where every money movement posts a balanced journal
-- entry. A later version may offer "invoice this route's students" through
-- the finance RPCs.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.transport_routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  fee_amount numeric(12,2) not null default 0 check (fee_amount >= 0),
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index transport_routes_tenant_idx on public.transport_routes (tenant_id);

create table public.transport_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  route_id uuid not null references public.transport_routes(id) on delete cascade,
  name text not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (route_id, name)
);
create index transport_stops_tenant_idx on public.transport_stops (tenant_id);
create index transport_stops_route_idx on public.transport_stops (route_id, sort_order);

create table public.transport_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  student_id uuid not null references public.students(id),
  route_id uuid not null references public.transport_routes(id),
  stop_id uuid references public.transport_stops(id),
  academic_year_id uuid not null references public.academic_years(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index transport_assignments_tenant_idx on public.transport_assignments (tenant_id);
create index transport_assignments_route_active_idx
  on public.transport_assignments (route_id) where active;
-- one ACTIVE assignment per student per academic year
create unique index transport_assignments_student_year_active_idx
  on public.transport_assignments (student_id, academic_year_id)
  where active;

-- RLS: members read; all writes via the API (service role).
alter table public.transport_routes enable row level security;
alter table public.transport_stops enable row level security;
alter table public.transport_assignments enable row level security;

create policy "members read transport routes" on public.transport_routes
  for select using (app.is_tenant_member(tenant_id));
create policy "members read transport stops" on public.transport_stops
  for select using (app.is_tenant_member(tenant_id));
create policy "members read transport assignments" on public.transport_assignments
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Assign a student to a route (+ optional stop). Validates that the student
-- is active, the route belongs to the tenant, and the stop (when given)
-- belongs to THAT route. Any previous active assignment for the student +
-- year is deactivated in the same transaction — re-assignment replaces.
-- ---------------------------------------------------------------------------
create or replace function app.assign_transport(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid,
  p_route_id uuid, p_stop_id uuid, p_year_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev public.transport_assignments%rowtype;
  v_assignment_id uuid;
begin
  if not exists (
    select 1 from public.students
    where id = p_student_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'TRANSPORT_STUDENT_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.transport_routes
    where id = p_route_id and tenant_id = p_tenant_id
  ) then
    raise exception 'TRANSPORT_ROUTE_NOT_FOUND';
  end if;

  if p_stop_id is not null and not exists (
    select 1 from public.transport_stops
    where id = p_stop_id and route_id = p_route_id and tenant_id = p_tenant_id
  ) then
    raise exception 'TRANSPORT_STOP_MISMATCH';
  end if;

  if not exists (
    select 1 from public.academic_years
    where id = p_year_id and tenant_id = p_tenant_id
  ) then
    raise exception 'TRANSPORT_YEAR_NOT_FOUND';
  end if;

  -- re-assignment replaces: deactivate any previous active assignment
  update public.transport_assignments
  set active = false
  where student_id = p_student_id
    and academic_year_id = p_year_id
    and active
  returning * into v_prev;

  insert into public.transport_assignments
    (tenant_id, student_id, route_id, stop_id, academic_year_id)
  values (p_tenant_id, p_student_id, p_route_id, p_stop_id, p_year_id)
  returning id into v_assignment_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor,
          case when v_prev.id is null then 'transport.assigned' else 'transport.reassigned' end,
          'transport_assignment', v_assignment_id::text,
          jsonb_build_object('studentId', p_student_id, 'routeId', p_route_id,
                             'stopId', p_stop_id, 'yearId', p_year_id,
                             'previousRouteId', v_prev.route_id));

  return jsonb_build_object(
    'assignmentId', v_assignment_id,
    'routeId', p_route_id,
    'stopId', p_stop_id,
    'previousRouteId', v_prev.route_id
  );
end;
$$;

-- Public wrapper — service role only (PostgREST exposes only public schema).
create or replace function public.assign_transport(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid,
  p_route_id uuid, p_stop_id uuid, p_year_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.assign_transport(p_tenant_id, p_actor, p_student_id, p_route_id, p_stop_id, p_year_id); $$;

revoke execute on function app.assign_transport(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.assign_transport(uuid, uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_transport(uuid, uuid, uuid, uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Active assignment count per route, computed in SQL. The API used to count
-- active assignment rows in JS, which the 1000-row read cap silently
-- truncated → under-counted riders on busy routes. Returns one row per route
-- that has any active assignment.
-- ---------------------------------------------------------------------------
create or replace function app.transport_route_load(p_tenant_id uuid)
returns table (route_id uuid, assigned int)
language sql
stable
security definer
set search_path = public
as $$
  select route_id, count(*)::int
  from public.transport_assignments
  where tenant_id = p_tenant_id and active
  group by route_id;
$$;

create or replace function public.transport_route_load(p_tenant_id uuid)
returns table (route_id uuid, assigned int)
language sql security definer set search_path = public
as $$ select * from app.transport_route_load(p_tenant_id); $$;

revoke execute on function app.transport_route_load(uuid) from public, anon, authenticated;
revoke execute on function public.transport_route_load(uuid) from public, anon, authenticated;
grant execute on function public.transport_route_load(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions (keys BEFORE role_permissions — FK). Mirrored in seed.sql.
-- school_owner/director are superusers in the API guard and need no rows.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('transport.view',   'transport', 'View transport routes and assignments'),
  ('transport.manage', 'transport', 'Manage transport routes, stops and assignments')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'teacher'         then array['transport.view']
  when 'class_teacher'   then array['transport.view']
  when 'head_teacher'    then array['transport.view', 'transport.manage']
  when 'school_admin'    then array['transport.view', 'transport.manage']
  when 'academic_master' then array['transport.view']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
