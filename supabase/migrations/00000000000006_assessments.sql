-- ATLAS migration 0006 — subjects, NECTA grading, assessments, marks,
-- report cards.
--
-- Grading follows Tanzanian national (NECTA) conventions, stored as data so
-- schools can override:
--   primary  (PSLE):  A 81-100, B 61-80, C 41-60, D 21-40, E 0-20
--   o_level  (CSEE):  A 75-100 (1pt), B 65-74 (2), C 45-64 (3), D 30-44 (4),
--                     F 0-29 (5); Division from best 7 subjects:
--                     I 7-17, II 18-21, III 22-25, IV 26-33, 0 above
--   a_level  (ACSEE): A 80-100 (1) … S 35-39 (6), F 0-34 (7)
-- grading_bands rows with tenant_id NULL are the national defaults; a tenant
-- row with the same education_level takes precedence.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  code text not null,
  name text not null,
  name_sw text,
  education_level text not null
    check (education_level in ('pre_primary','primary','o_level','a_level')),
  status text not null default 'active' check (status in ('active','archived')),
  created_at timestamptz not null default now(),
  unique (tenant_id, education_level, code)
);
create index subjects_tenant_idx on public.subjects (tenant_id, education_level);

create table public.grading_bands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  education_level text not null
    check (education_level in ('pre_primary','primary','o_level','a_level')),
  grade text not null,
  min_marks numeric(5,2) not null,
  max_marks numeric(5,2) not null,
  points smallint not null,
  unique nulls not distinct (tenant_id, education_level, grade),
  check (max_marks >= min_marks)
);

create table public.assessments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  class_section_id uuid not null references public.class_sections(id),
  academic_term_id uuid not null references public.academic_terms(id),
  name text not null,
  type text not null default 'test'
    check (type in ('test','midterm','terminal','mock','other')),
  -- relative weight when combining assessments into term results
  weight numeric(4,2) not null default 1 check (weight > 0),
  status text not null default 'draft' check (status in ('draft','published')),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_section_id, academic_term_id, name)
);
create index assessments_tenant_idx on public.assessments (tenant_id);
create index assessments_section_term_idx
  on public.assessments (class_section_id, academic_term_id, status);
create trigger assessments_updated_at before update on public.assessments
  for each row execute function app.set_updated_at();

create table public.assessment_scores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  assessment_id uuid not null references public.assessments(id) on delete cascade,
  student_id uuid not null references public.students(id),
  subject_id uuid not null references public.subjects(id),
  marks numeric(5,2) not null check (marks >= 0 and marks <= 100),
  grade text not null,
  points smallint not null,
  entered_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (assessment_id, subject_id, student_id)
);
create index assessment_scores_tenant_idx on public.assessment_scores (tenant_id);
create index assessment_scores_student_idx on public.assessment_scores (student_id);
create trigger assessment_scores_updated_at before update on public.assessment_scores
  for each row execute function app.set_updated_at();

-- RLS: members read; grading defaults (tenant_id null) readable by everyone
-- signed in; all writes via API.
alter table public.subjects enable row level security;
alter table public.grading_bands enable row level security;
alter table public.assessments enable row level security;
alter table public.assessment_scores enable row level security;

create policy "members read subjects" on public.subjects
  for select using (app.is_tenant_member(tenant_id));
create policy "members read grading bands" on public.grading_bands
  for select using (tenant_id is null or app.is_tenant_member(tenant_id));
create policy "members read assessments" on public.assessments
  for select using (app.is_tenant_member(tenant_id));
create policy "members read assessment scores" on public.assessment_scores
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- NECTA default grading bands (tenant_id null)
-- ---------------------------------------------------------------------------
insert into public.grading_bands (tenant_id, education_level, grade, min_marks, max_marks, points) values
  (null, 'primary', 'A', 81, 100, 1),
  (null, 'primary', 'B', 61,  80, 2),
  (null, 'primary', 'C', 41,  60, 3),
  (null, 'primary', 'D', 21,  40, 4),
  (null, 'primary', 'E',  0,  20, 5),
  (null, 'o_level', 'A', 75, 100, 1),
  (null, 'o_level', 'B', 65,  74, 2),
  (null, 'o_level', 'C', 45,  64, 3),
  (null, 'o_level', 'D', 30,  44, 4),
  (null, 'o_level', 'F',  0,  29, 5),
  (null, 'a_level', 'A', 80, 100, 1),
  (null, 'a_level', 'B', 70,  79, 2),
  (null, 'a_level', 'C', 60,  69, 3),
  (null, 'a_level', 'D', 50,  59, 4),
  (null, 'a_level', 'E', 40,  49, 5),
  (null, 'a_level', 'S', 35,  39, 6),
  (null, 'a_level', 'F',  0,  34, 7)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Grade lookup. If the tenant has custom bands for the level they are used as
-- a whole set; otherwise the national defaults apply. The band with the
-- highest min_marks at or below the marks wins, so decimal marks (weighted
-- averages like 74.5) never fall into a gap between bands.
-- ---------------------------------------------------------------------------
create or replace function app.grade_for(p_tenant_id uuid, p_level text, p_marks numeric)
returns table (grade text, points smallint)
language sql
stable
security definer
set search_path = public
as $$
  with tenant_bands as (
    select b.grade, b.points, b.min_marks from public.grading_bands b
    where b.education_level = p_level and b.tenant_id = p_tenant_id
  ), chosen as (
    select * from tenant_bands
    union all
    select b.grade, b.points, b.min_marks from public.grading_bands b
    where b.education_level = p_level and b.tenant_id is null
      and not exists (select 1 from tenant_bands)
  )
  select c.grade, c.points from chosen c
  where p_marks >= c.min_marks
  order by c.min_marks desc
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Bulk marks entry for one assessment + subject. All-or-nothing.
-- p_rows: [{ "studentId": uuid, "marks": 0-100 }]
-- Blocked once results are published (corrections to published results are a
-- separate, audited flow — results.correct_published — not yet built).
-- ---------------------------------------------------------------------------
create or replace function app.record_scores(
  p_tenant_id uuid, p_actor uuid, p_assessment_id uuid, p_subject_id uuid, p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_assessment public.assessments%rowtype;
  v_level text;
  v_subject_level text;
  v_bad uuid;
  v_count int := 0;
begin
  select * into v_assessment from public.assessments
  where id = p_assessment_id and tenant_id = p_tenant_id;
  if v_assessment.id is null then
    raise exception 'SCORES_ASSESSMENT_NOT_FOUND';
  end if;
  if v_assessment.status = 'published' then
    raise exception 'SCORES_ASSESSMENT_PUBLISHED';
  end if;

  select gl.education_level into v_level
  from public.class_sections cs
  join public.grade_levels gl on gl.id = cs.grade_level_id
  where cs.id = v_assessment.class_section_id;

  select education_level into v_subject_level from public.subjects
  where id = p_subject_id and tenant_id = p_tenant_id and status = 'active';
  if v_subject_level is null then
    raise exception 'SCORES_SUBJECT_NOT_FOUND';
  end if;
  if v_subject_level <> v_level then
    raise exception 'SCORES_SUBJECT_LEVEL_MISMATCH';
  end if;

  select (r->>'studentId')::uuid into v_bad
  from jsonb_array_elements(p_rows) r
  where not exists (
    select 1 from public.class_enrolments e
    where e.student_id = (r->>'studentId')::uuid
      and e.class_section_id = v_assessment.class_section_id
      and e.tenant_id = p_tenant_id
      and e.status = 'active'
  )
  limit 1;
  if v_bad is not null then
    raise exception 'SCORES_STUDENT_NOT_ENROLLED:%', v_bad;
  end if;

  insert into public.assessment_scores
    (tenant_id, assessment_id, student_id, subject_id, marks, grade, points, entered_by)
  select p_tenant_id, p_assessment_id, (r->>'studentId')::uuid, p_subject_id,
         (r->>'marks')::numeric, g.grade, g.points, p_actor
  from jsonb_array_elements(p_rows) r
  cross join lateral app.grade_for(p_tenant_id, v_level, (r->>'marks')::numeric) g
  on conflict (assessment_id, subject_id, student_id)
  do update set marks = excluded.marks, grade = excluded.grade,
                points = excluded.points, entered_by = excluded.entered_by;
  get diagnostics v_count = row_count;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'marks.entered', 'assessment', p_assessment_id::text,
          jsonb_build_object('subjectId', p_subject_id, 'rows', v_count));

  return jsonb_build_object('saved', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Publish results (locks marks entry)
-- ---------------------------------------------------------------------------
create or replace function app.publish_results(p_tenant_id uuid, p_actor uuid, p_assessment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.assessments
  where id = p_assessment_id and tenant_id = p_tenant_id;
  if v_status is null then
    raise exception 'RESULTS_ASSESSMENT_NOT_FOUND';
  end if;
  if v_status = 'published' then
    raise exception 'RESULTS_ALREADY_PUBLISHED';
  end if;

  update public.assessments set status = 'published' where id = p_assessment_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
  values (p_tenant_id, p_actor, 'results.published', 'assessment', p_assessment_id::text);

  return jsonb_build_object('assessmentId', p_assessment_id, 'status', 'published');
end;
$$;

-- ---------------------------------------------------------------------------
-- Report card for one student + term, from PUBLISHED assessments only.
-- Weighted per-subject averages, NECTA grade + points, O-Level division from
-- the best 7 subjects, position in class, and the term's attendance summary.
-- ---------------------------------------------------------------------------
create or replace function app.report_card(p_tenant_id uuid, p_student_id uuid, p_term_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_student public.students%rowtype;
  v_term public.academic_terms%rowtype;
  v_section_id uuid;
  v_section_name text;
  v_level text;
  v_subjects jsonb;
  v_average numeric;
  v_points int;
  v_subject_count int;
  v_division text;
  v_position int;
  v_class_size int;
  v_attendance jsonb;
  v_overall record;
begin
  select * into v_student from public.students
  where id = p_student_id and tenant_id = p_tenant_id;
  if v_student.id is null then
    raise exception 'REPORT_STUDENT_NOT_FOUND';
  end if;

  select * into v_term from public.academic_terms
  where id = p_term_id and tenant_id = p_tenant_id;
  if v_term.id is null then
    raise exception 'REPORT_TERM_NOT_FOUND';
  end if;

  select e.class_section_id,
         gl.name || ' ' || cs.name,
         gl.education_level
    into v_section_id, v_section_name, v_level
  from public.class_enrolments e
  join public.class_sections cs on cs.id = e.class_section_id
  join public.grade_levels gl on gl.id = cs.grade_level_id
  where e.student_id = p_student_id
    and e.academic_year_id = v_term.academic_year_id
    and e.status = 'active';
  if v_section_id is null then
    raise exception 'REPORT_STUDENT_NOT_ENROLLED';
  end if;

  -- per-subject weighted averages for this student
  with subject_avgs as (
    select sc.subject_id, sub.code, sub.name, sub.name_sw,
           round(sum(sc.marks * a.weight) / sum(a.weight), 1) as marks
    from public.assessment_scores sc
    join public.assessments a on a.id = sc.assessment_id
    join public.subjects sub on sub.id = sc.subject_id
    where sc.student_id = p_student_id
      and a.class_section_id = v_section_id
      and a.academic_term_id = p_term_id
      and a.status = 'published'
    group by sc.subject_id, sub.code, sub.name, sub.name_sw
  ), graded as (
    select s.*, g.grade, g.points
    from subject_avgs s
    cross join lateral app.grade_for(p_tenant_id, v_level, s.marks) g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'subjectId', subject_id, 'code', code, 'name', name, 'nameSw', name_sw,
           'marks', marks, 'grade', grade, 'points', points
         ) order by code), '[]'::jsonb),
         round(avg(marks), 1),
         count(*)::int,
         -- best (lowest) 7 point values for the O-Level division
         (select sum(points)::int from (
            select points from graded order by points asc limit 7
          ) best)
    into v_subjects, v_average, v_subject_count, v_points
  from graded;

  if v_level = 'o_level' and v_subject_count >= 7 then
    v_division := case
      when v_points <= 17 then 'I'
      when v_points <= 21 then 'II'
      when v_points <= 25 then 'III'
      when v_points <= 33 then 'IV'
      else '0'
    end;
  end if;

  -- position among section peers by overall average of published results
  with peer_avgs as (
    select sc.student_id, avg(subject_marks) as overall
    from (
      select sc2.student_id, sc2.subject_id,
             sum(sc2.marks * a.weight) / sum(a.weight) as subject_marks
      from public.assessment_scores sc2
      join public.assessments a on a.id = sc2.assessment_id
      where a.class_section_id = v_section_id
        and a.academic_term_id = p_term_id
        and a.status = 'published'
      group by sc2.student_id, sc2.subject_id
    ) sc
    group by sc.student_id
  ), ranked as (
    select student_id, rank() over (order by overall desc) as pos,
           count(*) over () as class_size
    from peer_avgs
  )
  select pos, class_size into v_position, v_class_size
  from ranked where student_id = p_student_id;

  select jsonb_object_agg(status, n) into v_attendance
  from (
    select ar.status, count(*)::int as n
    from public.attendance_records ar
    join public.attendance_sessions s on s.id = ar.session_id
    where ar.student_id = p_student_id
      and s.tenant_id = p_tenant_id
      and s.session_date between v_term.starts_on and v_term.ends_on
    group by ar.status
  ) c;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'id', v_student.id,
      'name', trim(v_student.first_name || ' ' || coalesce(v_student.middle_name || ' ', '') || v_student.last_name),
      'number', v_student.student_number
    ),
    'section', v_section_name,
    'term', jsonb_build_object('id', v_term.id, 'name', v_term.name,
                               'startsOn', v_term.starts_on, 'endsOn', v_term.ends_on),
    'educationLevel', v_level,
    'subjects', v_subjects,
    'average', v_average,
    'points', v_points,
    'division', v_division,
    'position', v_position,
    'classSize', v_class_size,
    'attendance', coalesce(v_attendance, '{}'::jsonb)
  );
end;
$$;

-- Public wrappers — service role only.
create or replace function public.record_scores(
  p_tenant_id uuid, p_actor uuid, p_assessment_id uuid, p_subject_id uuid, p_rows jsonb
)
returns jsonb language sql security definer set search_path = public
as $$ select app.record_scores(p_tenant_id, p_actor, p_assessment_id, p_subject_id, p_rows); $$;

create or replace function public.publish_results(p_tenant_id uuid, p_actor uuid, p_assessment_id uuid)
returns jsonb language sql security definer set search_path = public
as $$ select app.publish_results(p_tenant_id, p_actor, p_assessment_id); $$;

create or replace function public.report_card(p_tenant_id uuid, p_student_id uuid, p_term_id uuid)
returns jsonb language sql stable security definer set search_path = public
as $$ select app.report_card(p_tenant_id, p_student_id, p_term_id); $$;

revoke execute on function app.grade_for(uuid, text, numeric) from public, anon, authenticated;
revoke execute on function app.record_scores(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function app.publish_results(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function app.report_card(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.record_scores(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.publish_results(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.report_card(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.record_scores(uuid, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.publish_results(uuid, uuid, uuid) to service_role;
grant execute on function public.report_card(uuid, uuid, uuid) to service_role;
