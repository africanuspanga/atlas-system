-- ATLAS migration 0018 — NECTA academic pack.
--
-- A-Level (ACSEE) students take a SUBJECT COMBINATION: three principal
-- subjects plus General Studies (e.g. PCM = Physics/Chemistry/Advanced
-- Mathematics). The standard combination CATALOGUE ships as code presets
-- (apps/api/src/assessments/combinations.presets.ts, like subjects.presets.ts)
-- — this migration only adds the per-tenant tables, the assignment RPC, the
-- cumulative CA (Continuous Assessment) summary and the NECTA candidate
-- registration export. Grading/banding conventions reuse migration 0006
-- (app.grade_for, weighted averages over PUBLISHED assessments).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.subject_combinations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);
create index subject_combinations_tenant_idx
  on public.subject_combinations (tenant_id);

create table public.subject_combination_subjects (
  id uuid primary key default gen_random_uuid(),
  combination_id uuid not null
    references public.subject_combinations(id) on delete cascade,
  subject_id uuid not null references public.subjects(id),
  is_principal boolean not null default true,
  unique (combination_id, subject_id)
);
create index subject_combination_subjects_combination_idx
  on public.subject_combination_subjects (combination_id);

create table public.student_combinations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  student_id uuid not null references public.students(id),
  combination_id uuid not null references public.subject_combinations(id),
  academic_year_id uuid not null references public.academic_years(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id, academic_year_id)
);
create index student_combinations_tenant_idx
  on public.student_combinations (tenant_id);
create trigger student_combinations_updated_at
  before update on public.student_combinations
  for each row execute function app.set_updated_at();

-- RLS: members read; all writes via the API (service role).
alter table public.subject_combinations enable row level security;
alter table public.subject_combination_subjects enable row level security;
alter table public.student_combinations enable row level security;

create policy "members read subject combinations" on public.subject_combinations
  for select using (app.is_tenant_member(tenant_id));
create policy "members read combination subjects" on public.subject_combination_subjects
  for select using (exists (
    select 1 from public.subject_combinations c
    where c.id = combination_id and app.is_tenant_member(c.tenant_id)
  ));
create policy "members read student combinations" on public.student_combinations
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Assign (upsert) a student's combination for one academic year. The student
-- must be ACTIVELY enrolled in an a_level section for that year —
-- combinations are meaningless for O-Level/primary students.
-- ---------------------------------------------------------------------------
create or replace function app.assign_student_combination(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid,
  p_combination_id uuid, p_year_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_combination public.subject_combinations%rowtype;
  v_level text;
  v_id uuid;
begin
  select * into v_combination from public.subject_combinations
  where id = p_combination_id and tenant_id = p_tenant_id;
  if v_combination.id is null then
    raise exception 'COMBINATION_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.academic_years
    where id = p_year_id and tenant_id = p_tenant_id
  ) then
    raise exception 'COMBINATION_YEAR_NOT_FOUND';
  end if;

  if not exists (
    select 1 from public.students
    where id = p_student_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'COMBINATION_STUDENT_NOT_FOUND';
  end if;

  select gl.education_level into v_level
  from public.class_enrolments e
  join public.class_sections cs on cs.id = e.class_section_id
  join public.grade_levels gl on gl.id = cs.grade_level_id
  where e.student_id = p_student_id
    and e.academic_year_id = p_year_id
    and e.tenant_id = p_tenant_id
    and e.status = 'active';
  if v_level is null or v_level <> 'a_level' then
    raise exception 'COMBINATION_NOT_A_LEVEL';
  end if;

  insert into public.student_combinations
    (tenant_id, student_id, combination_id, academic_year_id)
  values (p_tenant_id, p_student_id, p_combination_id, p_year_id)
  on conflict (student_id, academic_year_id)
  do update set combination_id = excluded.combination_id
  returning id into v_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'academics.combination_assigned',
          'student_combination', v_id::text,
          jsonb_build_object('studentId', p_student_id,
                             'combinationId', p_combination_id,
                             'combinationCode', v_combination.code,
                             'academicYearId', p_year_id));

  return jsonb_build_object('studentCombinationId', v_id,
                            'combinationCode', v_combination.code);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cumulative CA summary for one section + academic year: per student the
-- weighted average per subject across ALL published assessments in ALL terms
-- of that year (assessments.weight, same formula as app.report_card), the
-- overall average and the rank in the section. Students with no published
-- marks appear with empty subjects and no rank.
-- ---------------------------------------------------------------------------
create or replace function app.report_ca_summary(
  p_tenant_id uuid, p_section_id uuid, p_year_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_section_name text;
  v_level text;
  v_year public.academic_years%rowtype;
  v_rows jsonb;
  v_count int;
begin
  select gl.name || ' ' || cs.name, gl.education_level
    into v_section_name, v_level
  from public.class_sections cs
  join public.grade_levels gl on gl.id = cs.grade_level_id
  where cs.id = p_section_id and cs.tenant_id = p_tenant_id;
  if v_section_name is null then
    raise exception 'CA_SECTION_NOT_FOUND';
  end if;

  select * into v_year from public.academic_years
  where id = p_year_id and tenant_id = p_tenant_id;
  if v_year.id is null then
    raise exception 'CA_YEAR_NOT_FOUND';
  end if;

  with published as (
    select a.id, a.weight
    from public.assessments a
    join public.academic_terms t on t.id = a.academic_term_id
    where a.tenant_id = p_tenant_id
      and a.class_section_id = p_section_id
      and a.status = 'published'
      and t.academic_year_id = p_year_id
  ), subject_avgs as (
    select sc.student_id, sc.subject_id, sub.code, sub.name,
           round(sum(sc.marks * p.weight) / sum(p.weight), 1) as marks
    from public.assessment_scores sc
    join published p on p.id = sc.assessment_id
    join public.subjects sub on sub.id = sc.subject_id
    group by sc.student_id, sc.subject_id, sub.code, sub.name
  ), graded as (
    select s.*, g.grade, g.points
    from subject_avgs s
    cross join lateral app.grade_for(p_tenant_id, v_level, s.marks) g
  ), per_student as (
    select st.id as student_id, st.student_number,
           trim(st.first_name || ' ' || coalesce(st.middle_name || ' ', '') || st.last_name) as name,
           coalesce(jsonb_agg(jsonb_build_object(
             'subjectId', g.subject_id, 'code', g.code, 'name', g.name,
             'marks', g.marks, 'grade', g.grade, 'points', g.points
           ) order by g.code) filter (where g.subject_id is not null), '[]'::jsonb) as subjects,
           round(avg(g.marks), 1) as average
    from public.class_enrolments e
    join public.students st on st.id = e.student_id
    left join graded g on g.student_id = st.id
    where e.class_section_id = p_section_id
      and e.academic_year_id = p_year_id
      and e.tenant_id = p_tenant_id
      and e.status = 'active'
    group by st.id, st.student_number, st.first_name, st.middle_name, st.last_name
  ), ranked as (
    select *,
           rank() over (order by average desc nulls last) as pos
    from per_student
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'studentId', student_id,
           'studentNumber', student_number,
           'name', name,
           'subjects', subjects,
           'average', average,
           'rank', case when average is null then null else pos end
         ) order by (average is null), pos, name), '[]'::jsonb),
         count(*)::int
    into v_rows, v_count
  from ranked;

  return jsonb_build_object(
    'section', v_section_name,
    'educationLevel', v_level,
    'year', jsonb_build_object('id', v_year.id, 'name', v_year.name),
    'rows', v_rows,
    'students', v_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- NECTA candidate registration prep for one section: student number, full
-- name (surname-first, uppercase), gender M/F, date of birth DD/MM/YYYY and —
-- for a_level sections — the assigned combination code for the section's
-- academic year. (PReM numbers can be added as a column later.)
-- ---------------------------------------------------------------------------
create or replace function app.export_candidates(p_tenant_id uuid, p_section_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_section_name text;
  v_level text;
  v_year_id uuid;
  v_rows jsonb;
  v_count int;
begin
  select gl.name || ' ' || cs.name, gl.education_level, cs.academic_year_id
    into v_section_name, v_level, v_year_id
  from public.class_sections cs
  join public.grade_levels gl on gl.id = cs.grade_level_id
  where cs.id = p_section_id and cs.tenant_id = p_tenant_id;
  if v_section_name is null then
    raise exception 'EXPORT_SECTION_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'studentNumber', c.student_number,
           'fullName', c.full_name,
           'gender', c.gender,
           'dateOfBirth', c.date_of_birth,
           'combination', c.combination
         ) order by c.full_name), '[]'::jsonb),
         count(*)::int
    into v_rows, v_count
  from (
    select st.student_number,
           upper(trim(st.last_name || ', ' || st.first_name
                 || coalesce(' ' || st.middle_name, ''))) as full_name,
           case st.gender when 'male' then 'M' else 'F' end as gender,
           to_char(st.date_of_birth, 'DD/MM/YYYY') as date_of_birth,
           case when v_level = 'a_level' then comb.code end as combination
    from public.class_enrolments e
    join public.students st on st.id = e.student_id
    left join public.student_combinations sc
      on sc.student_id = st.id
     and sc.academic_year_id = e.academic_year_id
     and sc.tenant_id = p_tenant_id
    left join public.subject_combinations comb on comb.id = sc.combination_id
    where e.class_section_id = p_section_id
      and e.academic_year_id = v_year_id
      and e.tenant_id = p_tenant_id
      and e.status = 'active'
  ) c;

  return jsonb_build_object(
    'section', v_section_name,
    'educationLevel', v_level,
    'rows', v_rows,
    'candidates', v_count
  );
end;
$$;

-- Public wrappers — service role only (PostgREST exposes only public schema).
create or replace function public.assign_student_combination(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid,
  p_combination_id uuid, p_year_id uuid
)
returns jsonb language sql security definer set search_path = public
as $$ select app.assign_student_combination(p_tenant_id, p_actor, p_student_id, p_combination_id, p_year_id); $$;

create or replace function public.report_ca_summary(
  p_tenant_id uuid, p_section_id uuid, p_year_id uuid
)
returns jsonb language sql stable security definer set search_path = public
as $$ select app.report_ca_summary(p_tenant_id, p_section_id, p_year_id); $$;

create or replace function public.export_candidates(p_tenant_id uuid, p_section_id uuid)
returns jsonb language sql stable security definer set search_path = public
as $$ select app.export_candidates(p_tenant_id, p_section_id); $$;

revoke execute on function app.assign_student_combination(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.report_ca_summary(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.export_candidates(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.assign_student_combination(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.report_ca_summary(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.export_candidates(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assign_student_combination(uuid, uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.report_ca_summary(uuid, uuid, uuid) to service_role;
grant execute on function public.export_candidates(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions (keys BEFORE role_permissions — FK). Mirrored in seed.sql.
-- Reads reuse students.view / academics.manage; school_owner/director are
-- superusers in the API guard and need no rows.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('academics.combinations.manage', 'academics', 'Manage A-Level subject combinations')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'head_teacher'    then array['academics.combinations.manage']
  when 'academic_master' then array['academics.combinations.manage']
  when 'school_admin'    then array['academics.combinations.manage']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
