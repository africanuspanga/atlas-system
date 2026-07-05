-- ATLAS migration 0005 — attendance module + absence alert outbox +
-- role permissions for non-owner roles.
--
-- attendance_sessions: one register per class section per day, submitted by a
-- teacher. Corrections overwrite the records but bump the revision and are
-- separately audited (attendance.correct permission enforced by the API).
-- notification_outbox: absence alerts are written in the SAME transaction as
-- the register (exactly-once); workers drain pending rows to the SMS gateway.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.attendance_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  class_section_id uuid not null references public.class_sections(id),
  academic_term_id uuid references public.academic_terms(id),
  session_date date not null,
  taken_by uuid not null references public.profiles(id),
  revision int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_section_id, session_date)
);
create index attendance_sessions_tenant_idx
  on public.attendance_sessions (tenant_id, session_date);
create trigger attendance_sessions_updated_at before update on public.attendance_sessions
  for each row execute function app.set_updated_at();

create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  session_id uuid not null references public.attendance_sessions(id) on delete cascade,
  student_id uuid not null references public.students(id),
  status text not null check (status in ('present','absent','late','excused')),
  note text,
  created_at timestamptz not null default now(),
  unique (session_id, student_id)
);
create index attendance_records_tenant_idx on public.attendance_records (tenant_id);
create index attendance_records_student_idx
  on public.attendance_records (student_id, status);

create table public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  channel text not null default 'sms' check (channel in ('sms','email')),
  recipient text not null,
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notification_outbox_pending_idx
  on public.notification_outbox (status, created_at) where status = 'pending';

-- RLS: members read attendance; outbox is service-role only (no policies).
alter table public.attendance_sessions enable row level security;
alter table public.attendance_records enable row level security;
alter table public.notification_outbox enable row level security;

create policy "members read attendance sessions" on public.attendance_sessions
  for select using (app.is_tenant_member(tenant_id));
create policy "members read attendance records" on public.attendance_records
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Atomic register submission
--
-- p_records: [{ "studentId": uuid, "status": "present|absent|late|excused",
--               "note"?: text }]
-- Every student must be actively enrolled in the section. On re-submission the
-- previous records are replaced, revision increments, and only NEWLY absent
-- students generate alerts (no duplicate SMS on corrections).
-- ---------------------------------------------------------------------------
create or replace function app.mark_attendance(
  p_tenant_id uuid, p_actor uuid, p_class_section_id uuid,
  p_date date, p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_revision int;
  v_term_id uuid;
  v_bad uuid;
  v_prev_absent uuid[] := '{}';
  v_alerts int := 0;
  v_counts jsonb;
begin
  if not exists (
    select 1 from public.class_sections
    where id = p_class_section_id and tenant_id = p_tenant_id
  ) then
    raise exception 'ATTENDANCE_SECTION_NOT_FOUND';
  end if;

  -- every submitted student must be actively enrolled in this section
  select (r->>'studentId')::uuid into v_bad
  from jsonb_array_elements(p_records) r
  where not exists (
    select 1 from public.class_enrolments e
    where e.student_id = (r->>'studentId')::uuid
      and e.class_section_id = p_class_section_id
      and e.tenant_id = p_tenant_id
      and e.status = 'active'
  )
  limit 1;
  if v_bad is not null then
    raise exception 'ATTENDANCE_STUDENT_NOT_ENROLLED:%', v_bad;
  end if;

  select id into v_term_id from public.academic_terms
  where tenant_id = p_tenant_id and p_date between starts_on and ends_on
  order by starts_on desc limit 1;

  select id, revision into v_session_id, v_revision
  from public.attendance_sessions
  where class_section_id = p_class_section_id and session_date = p_date;

  if v_session_id is null then
    insert into public.attendance_sessions
      (tenant_id, class_section_id, academic_term_id, session_date, taken_by)
    values (p_tenant_id, p_class_section_id, v_term_id, p_date, p_actor)
    returning id, revision into v_session_id, v_revision;
  else
    select coalesce(array_agg(student_id), '{}') into v_prev_absent
    from public.attendance_records
    where session_id = v_session_id and status = 'absent';

    update public.attendance_sessions
    set revision = revision + 1, taken_by = p_actor
    where id = v_session_id
    returning revision into v_revision;

    delete from public.attendance_records where session_id = v_session_id;
  end if;

  insert into public.attendance_records (tenant_id, session_id, student_id, status, note)
  select p_tenant_id, v_session_id,
         (r->>'studentId')::uuid, r->>'status', nullif(r->>'note','')
  from jsonb_array_elements(p_records) r;

  -- absence alerts for newly absent students → primary guardian with a phone
  insert into public.notification_outbox (tenant_id, recipient, template, payload)
  select p_tenant_id, g.phone, 'attendance.absent',
         jsonb_build_object(
           'studentId', s.id,
           'studentName', s.first_name || ' ' || s.last_name,
           'studentNumber', s.student_number,
           'guardianName', g.full_name,
           'date', p_date,
           'sessionId', v_session_id
         )
  from public.attendance_records ar
  join public.students s on s.id = ar.student_id
  join public.student_guardians sg on sg.student_id = s.id and sg.is_primary
  join public.guardians g on g.id = sg.guardian_id and g.phone is not null
  where ar.session_id = v_session_id
    and ar.status = 'absent'
    and not (ar.student_id = any (v_prev_absent));
  get diagnostics v_alerts = row_count;

  select jsonb_object_agg(status, n) into v_counts
  from (
    select status, count(*)::int as n
    from public.attendance_records
    where session_id = v_session_id
    group by status
  ) c;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor,
          case when v_revision = 1 then 'attendance.marked' else 'attendance.corrected' end,
          'attendance_session', v_session_id::text,
          jsonb_build_object('date', p_date, 'classSectionId', p_class_section_id,
                             'revision', v_revision, 'counts', v_counts));

  return jsonb_build_object(
    'sessionId', v_session_id,
    'revision', v_revision,
    'counts', coalesce(v_counts, '{}'::jsonb),
    'alertsQueued', v_alerts
  );
end;
$$;

-- Public wrapper — service role only (PostgREST exposes only public schema).
create or replace function public.mark_attendance(
  p_tenant_id uuid, p_actor uuid, p_class_section_id uuid, p_date date, p_records jsonb
)
returns jsonb language sql security definer set search_path = public
as $$ select app.mark_attendance(p_tenant_id, p_actor, p_class_section_id, p_date, p_records); $$;

revoke execute on function app.mark_attendance(uuid, uuid, uuid, date, jsonb) from public, anon, authenticated;
revoke execute on function public.mark_attendance(uuid, uuid, uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.mark_attendance(uuid, uuid, uuid, date, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Role permissions for non-owner system roles (idempotent; mirrored in
-- seed.sql for fresh environments). school_owner/director are superusers in
-- the API guard and need no rows.
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'teacher' then array[
    'students.view', 'attendance.view', 'attendance.mark', 'marks.enter']
  when 'class_teacher' then array[
    'students.view', 'guardians.view',
    'attendance.view', 'attendance.mark', 'attendance.correct', 'marks.enter']
  when 'head_teacher' then array[
    'students.view', 'students.create', 'students.update', 'students.archive',
    'guardians.view', 'guardians.manage', 'academics.manage',
    'attendance.view', 'attendance.mark', 'attendance.correct', 'attendance.approve',
    'exams.create', 'marks.enter', 'marks.moderate', 'results.publish',
    'members.invite', 'audit.view']
  when 'school_admin' then array[
    'students.view', 'students.create', 'students.update', 'students.archive',
    'guardians.view', 'guardians.manage',
    'attendance.view', 'members.invite']
  when 'academic_master' then array[
    'students.view', 'academics.manage', 'attendance.view',
    'exams.create', 'marks.enter', 'marks.moderate', 'results.publish']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
