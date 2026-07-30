-- ATLAS migration 0019 — hostel (bweni) module.
--
-- Tanzanian boarding schools group boarders into gender-segregated hostel
-- blocks (mabweni) made of rooms with fixed bed capacity. hostel_allocations
-- tracks which bed-space a student occupies per academic year; a transfer is
-- a re-allocation (the previous active allocation is released in the same
-- transaction). Only students with boarding_status = 'boarding' may be
-- allocated. Writes go through app.allocate_hostel_bed /
-- app.release_hostel_bed only.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.hostels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  gender text not null check (gender in ('male','female','mixed')),
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);
create index hostels_tenant_idx on public.hostels (tenant_id);

create table public.hostel_rooms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  hostel_id uuid not null references public.hostels(id) on delete cascade,
  name text not null,
  capacity int not null check (capacity > 0),
  created_at timestamptz not null default now(),
  unique (hostel_id, name)
);
create index hostel_rooms_tenant_idx on public.hostel_rooms (tenant_id);

create table public.hostel_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  student_id uuid not null references public.students(id),
  room_id uuid not null references public.hostel_rooms(id),
  academic_year_id uuid not null references public.academic_years(id),
  allocated_at timestamptz not null default now(),
  released_at timestamptz
);
create index hostel_allocations_tenant_idx on public.hostel_allocations (tenant_id);
create index hostel_allocations_room_active_idx
  on public.hostel_allocations (room_id) where released_at is null;
-- one ACTIVE allocation per student per academic year
create unique index hostel_allocations_student_year_active_idx
  on public.hostel_allocations (student_id, academic_year_id)
  where released_at is null;

-- RLS: members read; all writes via the API (service role).
alter table public.hostels enable row level security;
alter table public.hostel_rooms enable row level security;
alter table public.hostel_allocations enable row level security;

create policy "members read hostels" on public.hostels
  for select using (app.is_tenant_member(tenant_id));
create policy "members read hostel rooms" on public.hostel_rooms
  for select using (app.is_tenant_member(tenant_id));
create policy "members read hostel allocations" on public.hostel_allocations
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Allocate a bed. Validates that the student is active and a boarder, that
-- the hostel accepts the student's gender (mixed accepts all), and that the
-- room has a free bed (counting active allocations, excluding this student's
-- own so transfers within a full room still work). Any existing active
-- allocation for the student + year is released in the same transaction —
-- a transfer IS a re-allocation. The room row is locked to serialise
-- concurrent capacity checks.
-- ---------------------------------------------------------------------------
create or replace function app.allocate_hostel_bed(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid, p_room_id uuid, p_year_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student public.students%rowtype;
  v_room public.hostel_rooms%rowtype;
  v_hostel public.hostels%rowtype;
  v_occupied int;
  v_prev public.hostel_allocations%rowtype;
  v_allocation_id uuid;
begin
  select * into v_student from public.students
  where id = p_student_id and tenant_id = p_tenant_id and status = 'active';
  if v_student.id is null then
    raise exception 'HOSTEL_STUDENT_NOT_FOUND';
  end if;
  if v_student.boarding_status <> 'boarding' then
    raise exception 'HOSTEL_NOT_BOARDER';
  end if;

  -- lock the room row: concurrent allocations serialise on the capacity check
  select * into v_room from public.hostel_rooms
  where id = p_room_id and tenant_id = p_tenant_id
  for update;
  if v_room.id is null then
    raise exception 'HOSTEL_ROOM_NOT_FOUND';
  end if;

  select * into v_hostel from public.hostels where id = v_room.hostel_id;
  if v_hostel.gender <> 'mixed' and v_hostel.gender <> v_student.gender then
    raise exception 'HOSTEL_GENDER_MISMATCH';
  end if;

  if not exists (
    select 1 from public.academic_years
    where id = p_year_id and tenant_id = p_tenant_id
  ) then
    raise exception 'HOSTEL_YEAR_NOT_FOUND';
  end if;

  select count(*)::int into v_occupied
  from public.hostel_allocations
  where room_id = p_room_id and released_at is null
    and student_id <> p_student_id;
  if v_occupied >= v_room.capacity then
    raise exception 'HOSTEL_ROOM_FULL';
  end if;

  -- transfer semantics: a student physically occupies one bed at a time, so
  -- release ANY active allocation they hold (including prior years) — not just
  -- this year's. Otherwise re-allocating across years leaves the old bed
  -- occupied, over-counting occupancy and exceeding room capacity. Release all
  -- and keep the most recent for the audit note ("returning ... into" errors on
  -- multiple rows).
  with released as (
    update public.hostel_allocations
    set released_at = now()
    where student_id = p_student_id
      and tenant_id = p_tenant_id
      and released_at is null
    returning *
  )
  select * into v_prev from released order by allocated_at desc limit 1;

  insert into public.hostel_allocations
    (tenant_id, student_id, room_id, academic_year_id)
  values (p_tenant_id, p_student_id, p_room_id, p_year_id)
  returning id into v_allocation_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor,
          case when v_prev.id is null then 'hostel.allocated' else 'hostel.transferred' end,
          'hostel_allocation', v_allocation_id::text,
          jsonb_build_object('studentId', p_student_id, 'roomId', p_room_id,
                             'hostelId', v_hostel.id, 'yearId', p_year_id,
                             'previousRoomId', v_prev.room_id));

  return jsonb_build_object(
    'allocationId', v_allocation_id,
    'roomId', p_room_id,
    'hostelId', v_hostel.id,
    'transferredFromRoomId', v_prev.room_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Release a bed (student leaves the hostel or the year ends).
-- ---------------------------------------------------------------------------
create or replace function app.release_hostel_bed(
  p_tenant_id uuid, p_actor uuid, p_allocation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allocation public.hostel_allocations%rowtype;
begin
  update public.hostel_allocations
  set released_at = now()
  where id = p_allocation_id and tenant_id = p_tenant_id and released_at is null
  returning * into v_allocation;
  if v_allocation.id is null then
    raise exception 'HOSTEL_ALLOCATION_NOT_FOUND';
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'hostel.released', 'hostel_allocation',
          p_allocation_id::text,
          jsonb_build_object('studentId', v_allocation.student_id,
                             'roomId', v_allocation.room_id));

  return jsonb_build_object('released', true);
end;
$$;

-- Public wrappers — service role only (PostgREST exposes only public schema).
create or replace function public.allocate_hostel_bed(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid, p_room_id uuid, p_year_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.allocate_hostel_bed(p_tenant_id, p_actor, p_student_id, p_room_id, p_year_id); $$;

create or replace function public.release_hostel_bed(
  p_tenant_id uuid, p_actor uuid, p_allocation_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.release_hostel_bed(p_tenant_id, p_actor, p_allocation_id); $$;

revoke execute on function app.allocate_hostel_bed(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.release_hostel_bed(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.allocate_hostel_bed(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.release_hostel_bed(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.allocate_hostel_bed(uuid, uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.release_hostel_bed(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Active occupancy per room, computed in SQL. The API used to count active
-- allocation rows in JS, which the 1000-row read cap silently truncated →
-- under-counted occupancy for large hostels. Returns one row per occupied
-- room.
-- ---------------------------------------------------------------------------
create or replace function app.hostel_occupancy(p_tenant_id uuid)
returns table (room_id uuid, occupied int)
language sql
stable
security definer
set search_path = public
as $$
  select room_id, count(*)::int
  from public.hostel_allocations
  where tenant_id = p_tenant_id and released_at is null
  group by room_id;
$$;

create or replace function public.hostel_occupancy(p_tenant_id uuid)
returns table (room_id uuid, occupied int)
language sql security definer set search_path = public
as $$ select * from app.hostel_occupancy(p_tenant_id); $$;

revoke execute on function app.hostel_occupancy(uuid) from public, anon, authenticated;
revoke execute on function public.hostel_occupancy(uuid) from public, anon, authenticated;
grant execute on function public.hostel_occupancy(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions (keys BEFORE role_permissions — FK). Mirrored in seed.sql.
-- school_owner/director are superusers in the API guard and need no rows.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('hostel.view',   'hostel', 'View hostels and allocations'),
  ('hostel.manage', 'hostel', 'Manage hostels, rooms and bed allocations')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'teacher'         then array['hostel.view']
  when 'class_teacher'   then array['hostel.view']
  when 'head_teacher'    then array['hostel.view', 'hostel.manage']
  when 'school_admin'    then array['hostel.view', 'hostel.manage']
  when 'academic_master' then array['hostel.view']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
