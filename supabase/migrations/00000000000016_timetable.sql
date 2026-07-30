-- ATLAS migration 0016 — timetable module.
--
-- timetable_periods: a school-wide set of named daily periods (with breaks).
-- timetable_slots: one lesson per class section + weekday (Mon–Fri, 1–5) +
-- period, taught by a staff member. A teacher can never be in two different
-- sections at the same day+period (TIMETABLE_TEACHER_CLASH). Writes go
-- through app.set_timetable_slot / app.delete_timetable_slot only.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.timetable_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  label text not null,
  starts_at time not null,
  ends_at time not null,
  is_break boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, label),
  check (ends_at > starts_at)
);
create index timetable_periods_tenant_idx
  on public.timetable_periods (tenant_id, sort_order);

create table public.timetable_slots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  class_section_id uuid not null references public.class_sections(id),
  day_of_week int not null check (day_of_week between 1 and 5),
  period_id uuid not null references public.timetable_periods(id) on delete cascade,
  subject_id uuid not null references public.subjects(id),
  teacher_user_id uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, class_section_id, day_of_week, period_id)
);
create index timetable_slots_tenant_section_idx
  on public.timetable_slots (tenant_id, class_section_id);
-- UNIQUE: a teacher can be in at most one section per tenant+day+period. This
-- is the authoritative DB-level guard against the TOCTOU race where two
-- concurrent set_timetable_slot calls both pass the exists() check and
-- double-book the teacher. Equivalent to the invariant because
-- (tenant_id, class_section_id, day_of_week, period_id) is already unique.
create unique index timetable_slots_teacher_idx
  on public.timetable_slots (tenant_id, teacher_user_id, day_of_week, period_id);
create trigger timetable_slots_updated_at before update on public.timetable_slots
  for each row execute function app.set_updated_at();

-- RLS: members read; all writes via the API (service role).
alter table public.timetable_periods enable row level security;
alter table public.timetable_slots enable row level security;

create policy "members read timetable periods" on public.timetable_periods
  for select using (app.is_tenant_member(tenant_id));
create policy "members read timetable slots" on public.timetable_slots
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Upsert one slot. Validates that the period, section and subject belong to
-- the tenant, that the subject's education level matches the section's grade
-- level (same rule as app.record_scores), that the teacher is an active
-- member of the tenant, and that the teacher is not already teaching a
-- DIFFERENT section at the same day+period.
-- ---------------------------------------------------------------------------
create or replace function app.set_timetable_slot(
  p_tenant_id uuid, p_actor uuid, p_section_id uuid, p_day int,
  p_period_id uuid, p_subject_id uuid, p_teacher_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_level text;
  v_subject_level text;
  v_is_break boolean;
  v_slot_id uuid;
begin
  if p_day is null or p_day < 1 or p_day > 5 then
    raise exception 'TIMETABLE_BAD_DAY';
  end if;

  select gl.education_level into v_level
  from public.class_sections cs
  join public.grade_levels gl on gl.id = cs.grade_level_id
  where cs.id = p_section_id and cs.tenant_id = p_tenant_id;
  if v_level is null then
    raise exception 'TIMETABLE_SECTION_NOT_FOUND';
  end if;

  select is_break into v_is_break from public.timetable_periods
  where id = p_period_id and tenant_id = p_tenant_id;
  if v_is_break is null then
    raise exception 'TIMETABLE_PERIOD_NOT_FOUND';
  end if;
  if v_is_break then
    raise exception 'TIMETABLE_PERIOD_IS_BREAK';
  end if;

  select education_level into v_subject_level from public.subjects
  where id = p_subject_id and tenant_id = p_tenant_id and status = 'active';
  if v_subject_level is null then
    raise exception 'TIMETABLE_SUBJECT_NOT_FOUND';
  end if;
  if v_subject_level <> v_level then
    raise exception 'TIMETABLE_SUBJECT_LEVEL_MISMATCH';
  end if;

  if not exists (
    select 1 from public.tenant_memberships
    where tenant_id = p_tenant_id and user_id = p_teacher_user_id
      and status = 'active'
  ) then
    raise exception 'TIMETABLE_TEACHER_NOT_FOUND';
  end if;

  -- teacher clash: same teacher, same day+period, in a DIFFERENT section.
  -- This pre-check gives a friendly error for the common case; the unique
  -- index timetable_slots_teacher_idx is the race-proof backstop (a concurrent
  -- insert that slips past this check hits the index and is caught below).
  if exists (
    select 1 from public.timetable_slots
    where tenant_id = p_tenant_id
      and teacher_user_id = p_teacher_user_id
      and day_of_week = p_day
      and period_id = p_period_id
      and class_section_id <> p_section_id
  ) then
    raise exception 'TIMETABLE_TEACHER_CLASH';
  end if;

  begin
    insert into public.timetable_slots
      (tenant_id, class_section_id, day_of_week, period_id, subject_id, teacher_user_id)
    values (p_tenant_id, p_section_id, p_day, p_period_id, p_subject_id, p_teacher_user_id)
    on conflict (tenant_id, class_section_id, day_of_week, period_id)
    do update set subject_id = excluded.subject_id,
                  teacher_user_id = excluded.teacher_user_id
    returning id into v_slot_id;
  exception when unique_violation then
    -- the section-key conflict is absorbed by the ON CONFLICT arbiter, so any
    -- unique_violation reaching here is the teacher index — a raced clash.
    raise exception 'TIMETABLE_TEACHER_CLASH';
  end;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'timetable.slot_set', 'timetable_slot', v_slot_id::text,
          jsonb_build_object('classSectionId', p_section_id, 'day', p_day,
                             'periodId', p_period_id, 'subjectId', p_subject_id,
                             'teacherUserId', p_teacher_user_id));

  return jsonb_build_object('slotId', v_slot_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Delete one slot.
-- ---------------------------------------------------------------------------
create or replace function app.delete_timetable_slot(
  p_tenant_id uuid, p_actor uuid, p_slot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot public.timetable_slots%rowtype;
begin
  delete from public.timetable_slots
  where id = p_slot_id and tenant_id = p_tenant_id
  returning * into v_slot;
  if v_slot.id is null then
    raise exception 'TIMETABLE_SLOT_NOT_FOUND';
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'timetable.slot_deleted', 'timetable_slot', p_slot_id::text,
          jsonb_build_object('classSectionId', v_slot.class_section_id,
                             'day', v_slot.day_of_week, 'periodId', v_slot.period_id));

  return jsonb_build_object('deleted', true);
end;
$$;

-- Public wrappers — service role only (PostgREST exposes only public schema).
create or replace function public.set_timetable_slot(
  p_tenant_id uuid, p_actor uuid, p_section_id uuid, p_day int,
  p_period_id uuid, p_subject_id uuid, p_teacher_user_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.set_timetable_slot(p_tenant_id, p_actor, p_section_id, p_day, p_period_id, p_subject_id, p_teacher_user_id); $$;

create or replace function public.delete_timetable_slot(
  p_tenant_id uuid, p_actor uuid, p_slot_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.delete_timetable_slot(p_tenant_id, p_actor, p_slot_id); $$;

revoke execute on function app.set_timetable_slot(uuid, uuid, uuid, int, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.delete_timetable_slot(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.set_timetable_slot(uuid, uuid, uuid, int, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.delete_timetable_slot(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.set_timetable_slot(uuid, uuid, uuid, int, uuid, uuid, uuid) to service_role;
grant execute on function public.delete_timetable_slot(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions (keys BEFORE role_permissions — FK). Mirrored in seed.sql.
-- school_owner/director are superusers in the API guard and need no rows.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('timetable.view',   'timetable', 'View timetables'),
  ('timetable.manage', 'timetable', 'Manage timetables')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'head_teacher'    then array['timetable.view', 'timetable.manage']
  when 'academic_master' then array['timetable.view', 'timetable.manage']
  when 'school_admin'    then array['timetable.view', 'timetable.manage']
  when 'teacher'         then array['timetable.view']
  when 'class_teacher'   then array['timetable.view']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
