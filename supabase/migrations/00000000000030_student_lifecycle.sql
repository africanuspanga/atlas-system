-- ---------------------------------------------------------------------------
-- 0030 — student & academic lifecycle
--
-- Closes THEME 4 of the 2026-07-31 code review
-- (docs/audit/ATLAS_CODE_REVIEW_2026-07.md). Four confirmed HIGHs, one shape:
-- the schema models a full lifecycle but only ONE writer was ever built — the
-- onboarding wizard. Every table below is INSERTed exactly once, at
-- app.onboard_school, and never written again by any controller, RPC or AI
-- action.
--
--   LIFE-030-A  students.status is never written. `grep -rn "\.update("` over
--               apps/api/src returns zero hits on `students`, and no
--               PATCH/DELETE route exists. The column allows
--               transferred/withdrawn/graduated/archived but a departed pupil
--               is indistinguishable from an enrolled one, forever. Because
--               app.tenant_entitlements counts `status = 'active'`, a leaver
--               permanently occupies a paid plan seat: a 300-seat school with
--               25 Form 4 leavers cannot admit a 301st pupil and gets
--               PLAN_LIMIT_STUDENTS on every new admission. They also keep
--               being invoiced, keep receiving absence SMS (real money), and
--               stay visible in the parent portal.
--
--   LIFE-030-B  A student created without a class can never be given one.
--               class_enrolments is only ever INSERTed (0004, 0009, 0010,
--               0011) — never UPDATEd or DELETEd. A roster imported with a
--               blank/unmatched class column produces students with zero
--               enrolments, invisible to every register, mark sheet and
--               report card for the rest of the year.
--
--   LIFE-030-C  A mis-assigned class can never be corrected. `unique
--               (student_id, academic_year_id)` blocks inserting a second row
--               and no UPDATE path exists, so a single mistyped stream letter
--               ("Form 1 A" vs "Form 1 B") is permanent for the academic year:
--               the pupil never appears on their real class register.
--
--   LIFE-030-D  No second academic year. academic_years, academic_terms,
--               grade_levels and class_sections are written ONLY inside
--               app.onboard_school, which runs once per tenant. A school that
--               onboarded with "2026" is frozen there — January 2027 has no
--               path forward at all.
--
-- Additive-only. Reuses the permission keys already seeded in 0005/seed.sql:
-- students.update, students.archive (both previously dead — granted to
-- head_teacher/school_admin and documented in the admin guide, but with no
-- endpoint behind them) and academics.manage.
--
-- Atomic by construction, for the reason documented at length in 0029.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Student status (LIFE-030-A)
--
-- Withdrawing a student also closes their open enrolment: leaving both rows
-- 'active' is precisely the inconsistency that keeps a leaver on the register.
-- ---------------------------------------------------------------------------
create or replace function app.set_student_status(
  p_tenant_id uuid,
  p_actor uuid,
  p_student_id uuid,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before text;
begin
  if p_status not in ('active','transferred','withdrawn','graduated','archived') then
    raise exception 'STUDENT_STATUS_INVALID';
  end if;

  -- AUD-001: never trust an id from the request body — prove same-tenant first.
  select status into v_before from public.students
  where id = p_student_id and tenant_id = p_tenant_id;
  if v_before is null then
    raise exception 'STUDENT_NOT_FOUND';
  end if;
  if v_before = p_status then
    return jsonb_build_object('studentId', p_student_id, 'status', p_status, 'changed', false);
  end if;

  update public.students
     set status = p_status, updated_at = now()
   where id = p_student_id and tenant_id = p_tenant_id;

  -- A pupil who has left is no longer enrolled anywhere. 'completed' for a
  -- graduand, 'left' for everyone else; re-activating does NOT resurrect an
  -- enrolment (the year may have moved on — re-enrol explicitly).
  if p_status in ('transferred','withdrawn','graduated','archived') then
    update public.class_enrolments
       set status = case when p_status = 'graduated' then 'completed' else 'left' end
     where student_id = p_student_id
       and tenant_id = p_tenant_id
       and status = 'active';
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, before, after)
  values (p_tenant_id, p_actor, 'student.status_changed', 'student', p_student_id::text,
          jsonb_build_object('status', v_before),
          jsonb_build_object('status', p_status, 'reason', p_reason));

  return jsonb_build_object('studentId', p_student_id, 'status', p_status, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Assign / transfer a class enrolment (LIFE-030-B, LIFE-030-C)
--
-- One entry point for both cases: the unique (student_id, academic_year_id)
-- constraint makes "assign" and "transfer" the same operation — upsert the
-- year's single enrolment row.
-- ---------------------------------------------------------------------------
create or replace function app.set_class_enrolment(
  p_tenant_id uuid,
  p_actor uuid,
  p_student_id uuid,
  p_section_id uuid,
  p_year_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year_id uuid;
  v_section_year uuid;
  v_before uuid;
  v_enrolment_id uuid;
begin
  if not exists (select 1 from public.students
                 where id = p_student_id and tenant_id = p_tenant_id) then
    raise exception 'ENROLMENT_STUDENT_NOT_FOUND';
  end if;

  select academic_year_id into v_section_year from public.class_sections
  where id = p_section_id and tenant_id = p_tenant_id and status = 'active';
  if v_section_year is null then
    raise exception 'ENROLMENT_SECTION_NOT_FOUND';
  end if;

  -- Default to the section's own year, so a caller can never silently file a
  -- pupil into a section that belongs to a different year.
  v_year_id := coalesce(p_year_id, v_section_year);
  if v_year_id <> v_section_year then
    raise exception 'ENROLMENT_YEAR_MISMATCH';
  end if;

  select class_section_id, id into v_before, v_enrolment_id
  from public.class_enrolments
  where student_id = p_student_id and academic_year_id = v_year_id;

  if v_enrolment_id is null then
    insert into public.class_enrolments
      (tenant_id, student_id, class_section_id, academic_year_id, status)
    values (p_tenant_id, p_student_id, p_section_id, v_year_id, 'active')
    returning id into v_enrolment_id;
  elsif v_before = p_section_id then
    -- Idempotent, but still re-open a closed row (used to re-enrol a returner).
    update public.class_enrolments set status = 'active'
    where id = v_enrolment_id and status <> 'active';
    return jsonb_build_object('enrolmentId', v_enrolment_id, 'changed', false);
  else
    update public.class_enrolments
       set class_section_id = p_section_id, status = 'active'
     where id = v_enrolment_id;
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, before, after)
  values (p_tenant_id, p_actor,
          case when v_before is null then 'enrolment.assigned' else 'enrolment.transferred' end,
          'class_enrolment', v_enrolment_id::text,
          jsonb_build_object('classSectionId', v_before),
          jsonb_build_object('classSectionId', p_section_id, 'academicYearId', v_year_id));

  return jsonb_build_object('enrolmentId', v_enrolment_id, 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Academic-year rollover (LIFE-030-D)
--
-- Creates the year, its terms, and — optionally — a full set of class sections
-- cloned from an existing year, so a school rolls over in one call instead of
-- hand-building every stream again. Grade levels are tenant-wide and reused.
-- ---------------------------------------------------------------------------
create or replace function app.create_academic_year(
  p_tenant_id uuid,
  p_actor uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_year_id uuid;
  v_term jsonb;
  v_seq smallint := 0;
  v_clone_from uuid;
  v_campus_id uuid;
  v_sections int := 0;
  v_terms int := 0;
begin
  if nullif(p_payload->>'name','') is null then
    raise exception 'YEAR_NAME_REQUIRED';
  end if;
  if jsonb_array_length(coalesce(p_payload->'terms','[]'::jsonb)) = 0 then
    raise exception 'YEAR_TERMS_REQUIRED';
  end if;
  if exists (select 1 from public.academic_years
             where tenant_id = p_tenant_id and name = p_payload->>'name') then
    raise exception 'YEAR_NAME_TAKEN';
  end if;

  insert into public.academic_years (tenant_id, name, starts_on, ends_on, status)
  values (p_tenant_id,
          p_payload->>'name',
          (p_payload->>'startsOn')::date,
          (p_payload->>'endsOn')::date,
          coalesce(nullif(p_payload->>'status',''), 'draft'))
  returning id into v_year_id;

  for v_term in select * from jsonb_array_elements(p_payload->'terms')
  loop
    v_seq := v_seq + 1;
    insert into public.academic_terms
      (tenant_id, academic_year_id, name, sequence, starts_on, ends_on)
    values (p_tenant_id, v_year_id, v_term->>'name', v_seq,
            (v_term->>'startsOn')::date, (v_term->>'endsOn')::date);
    v_terms := v_terms + 1;
  end loop;

  -- Optional: clone the section grid (grade + stream name) from another year.
  v_clone_from := nullif(p_payload->>'cloneSectionsFromYearId','')::uuid;
  if v_clone_from is not null then
    if not exists (select 1 from public.academic_years
                   where id = v_clone_from and tenant_id = p_tenant_id) then
      raise exception 'YEAR_CLONE_SOURCE_NOT_FOUND';
    end if;
    insert into public.class_sections
      (tenant_id, campus_id, academic_year_id, grade_level_id, name, capacity)
    select cs.tenant_id, cs.campus_id, v_year_id, cs.grade_level_id, cs.name, cs.capacity
    from public.class_sections cs
    where cs.academic_year_id = v_clone_from
      and cs.tenant_id = p_tenant_id
      and cs.status = 'active'
    on conflict (academic_year_id, grade_level_id, name) do nothing;
    get diagnostics v_sections = row_count;
  else
    select id into v_campus_id from public.campuses
    where tenant_id = p_tenant_id and is_main = true;
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'academic_year.created', 'academic_year', v_year_id::text,
          jsonb_build_object('name', p_payload->>'name', 'terms', v_terms, 'sections', v_sections));

  return jsonb_build_object(
    'academicYearId', v_year_id, 'terms', v_terms, 'sectionsCloned', v_sections);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Grade level + class section writers (LIFE-030-D)
-- ---------------------------------------------------------------------------
create or replace function app.create_grade_level(
  p_tenant_id uuid, p_actor uuid, p_education_level text, p_name text, p_sequence smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if p_education_level not in ('pre_primary','primary','o_level','a_level') then
    raise exception 'GRADE_LEVEL_INVALID';
  end if;
  if exists (select 1 from public.grade_levels
             where tenant_id = p_tenant_id and name = p_name) then
    raise exception 'GRADE_NAME_TAKEN';
  end if;
  insert into public.grade_levels (tenant_id, education_level, name, sequence)
  values (p_tenant_id, p_education_level, p_name, p_sequence)
  returning id into v_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'grade_level.created', 'grade_level', v_id::text,
          jsonb_build_object('name', p_name, 'educationLevel', p_education_level));
  return jsonb_build_object('gradeLevelId', v_id);
end;
$$;

create or replace function app.create_class_section(
  p_tenant_id uuid, p_actor uuid, p_year_id uuid, p_grade_id uuid,
  p_name text, p_capacity smallint default null, p_campus_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_campus uuid;
begin
  if not exists (select 1 from public.academic_years
                 where id = p_year_id and tenant_id = p_tenant_id) then
    raise exception 'SECTION_YEAR_NOT_FOUND';
  end if;
  if not exists (select 1 from public.grade_levels
                 where id = p_grade_id and tenant_id = p_tenant_id) then
    raise exception 'SECTION_GRADE_NOT_FOUND';
  end if;

  v_campus := p_campus_id;
  if v_campus is null then
    select id into v_campus from public.campuses
    where tenant_id = p_tenant_id and is_main = true;
  elsif not exists (select 1 from public.campuses
                    where id = v_campus and tenant_id = p_tenant_id) then
    raise exception 'SECTION_CAMPUS_NOT_FOUND';
  end if;
  if v_campus is null then
    raise exception 'SECTION_CAMPUS_NOT_FOUND';
  end if;

  if exists (select 1 from public.class_sections
             where academic_year_id = p_year_id and grade_level_id = p_grade_id and name = p_name) then
    raise exception 'SECTION_NAME_TAKEN';
  end if;

  insert into public.class_sections
    (tenant_id, campus_id, academic_year_id, grade_level_id, name, capacity)
  values (p_tenant_id, v_campus, p_year_id, p_grade_id, p_name, p_capacity)
  returning id into v_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'class_section.created', 'class_section', v_id::text,
          jsonb_build_object('name', p_name, 'academicYearId', p_year_id));
  return jsonb_build_object('classSectionId', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Activating a year closes the previous one (LIFE-030-D)
--    students.controller's loadContext picks the newest year with
--    status='active', so two active years would make section resolution
--    non-deterministic.
-- ---------------------------------------------------------------------------
create or replace function app.activate_academic_year(
  p_tenant_id uuid, p_actor uuid, p_year_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_closed int;
begin
  if not exists (select 1 from public.academic_years
                 where id = p_year_id and tenant_id = p_tenant_id) then
    raise exception 'YEAR_NOT_FOUND';
  end if;
  update public.academic_years set status = 'closed', updated_at = now()
  where tenant_id = p_tenant_id and status = 'active' and id <> p_year_id;
  get diagnostics v_closed = row_count;

  update public.academic_years set status = 'active', updated_at = now()
  where id = p_year_id and tenant_id = p_tenant_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'academic_year.activated', 'academic_year', p_year_id::text,
          jsonb_build_object('closedPrevious', v_closed));
  return jsonb_build_object('academicYearId', p_year_id, 'closedPrevious', v_closed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Public wrappers — service role only (PostgREST exposes only `public`).
-- ---------------------------------------------------------------------------
create or replace function public.set_student_status(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid, p_status text, p_reason text
)
returns jsonb language sql security definer set search_path = public
as $$ select app.set_student_status(p_tenant_id, p_actor, p_student_id, p_status, p_reason); $$;

create or replace function public.set_class_enrolment(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid, p_section_id uuid, p_year_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.set_class_enrolment(p_tenant_id, p_actor, p_student_id, p_section_id, p_year_id); $$;

create or replace function public.create_academic_year(
  p_tenant_id uuid, p_actor uuid, p_payload jsonb
)
returns jsonb language sql security definer set search_path = public
as $$ select app.create_academic_year(p_tenant_id, p_actor, p_payload); $$;

create or replace function public.create_grade_level(
  p_tenant_id uuid, p_actor uuid, p_education_level text, p_name text, p_sequence smallint
)
returns jsonb language sql security definer set search_path = public
as $$ select app.create_grade_level(p_tenant_id, p_actor, p_education_level, p_name, p_sequence); $$;

create or replace function public.create_class_section(
  p_tenant_id uuid, p_actor uuid, p_year_id uuid, p_grade_id uuid,
  p_name text, p_capacity smallint, p_campus_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.create_class_section(p_tenant_id, p_actor, p_year_id, p_grade_id, p_name, p_capacity, p_campus_id); $$;

create or replace function public.activate_academic_year(
  p_tenant_id uuid, p_actor uuid, p_year_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.activate_academic_year(p_tenant_id, p_actor, p_year_id); $$;

revoke execute on function app.set_student_status(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function app.set_class_enrolment(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.create_academic_year(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function app.create_grade_level(uuid, uuid, text, text, smallint) from public, anon, authenticated;
revoke execute on function app.create_class_section(uuid, uuid, uuid, uuid, text, smallint, uuid) from public, anon, authenticated;
revoke execute on function app.activate_academic_year(uuid, uuid, uuid) from public, anon, authenticated;

revoke execute on function public.set_student_status(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function public.set_class_enrolment(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.create_academic_year(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.create_grade_level(uuid, uuid, text, text, smallint) from public, anon, authenticated;
revoke execute on function public.create_class_section(uuid, uuid, uuid, uuid, text, smallint, uuid) from public, anon, authenticated;
revoke execute on function public.activate_academic_year(uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.set_student_status(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.set_class_enrolment(uuid, uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.create_academic_year(uuid, uuid, jsonb) to service_role;
grant execute on function public.create_grade_level(uuid, uuid, text, text, smallint) to service_role;
grant execute on function public.create_class_section(uuid, uuid, uuid, uuid, text, smallint, uuid) to service_role;
grant execute on function public.activate_academic_year(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Index for the seat-cap / roster counts these writers now change.
-- ---------------------------------------------------------------------------
create index if not exists students_tenant_status_idx
  on public.students (tenant_id, status);

commit;
