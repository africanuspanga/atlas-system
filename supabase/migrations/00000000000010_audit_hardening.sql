-- ATLAS migration 0010 — production-readiness hardening (audit findings).
--
-- 1. AUD-001 (P1): app.import_students accepted a classSectionId without
--    verifying it belongs to the importing tenant — a staff member could
--    enrol their student into another school's class section. Enrolment now
--    validates section ownership.
-- 2. AUD-002 (P1): financial records were immutable by convention only.
--    UPDATE/DELETE are now blocked at the database level for payments,
--    journal_entries, journal_lines and invoice_lines (defence in depth —
--    even service-role code cannot silently rewrite the books).
-- 3. AUD-003 (P2): two simultaneous submissions of the same register
--    (section + date) raced on the unique constraint and surfaced as a 500.
--    mark_attendance now serialises per (section, date) with an advisory
--    transaction lock.

-- ---------------------------------------------------------------------------
-- 1. import_students: cross-tenant section guard
-- ---------------------------------------------------------------------------
create or replace function app.import_students(
  p_tenant_id uuid, p_actor uuid, p_campus_id uuid, p_year_id uuid, p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row jsonb;
  v_student_id uuid;
  v_guardian_id uuid;
  v_number text;
  v_section uuid;
  v_count int := 0;
begin
  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    v_number := 'STU-' || lpad(app.next_counter(p_tenant_id, 'student_number')::text, 5, '0');

    insert into public.students
      (tenant_id, campus_id, student_number, first_name, middle_name, last_name,
       gender, date_of_birth, boarding_status, created_by)
    values
      (p_tenant_id, p_campus_id, v_number,
       v_row->>'firstName', v_row->>'middleName', v_row->>'lastName',
       v_row->>'gender',
       nullif(v_row->>'dateOfBirth','')::date,
       coalesce(nullif(v_row->>'boardingStatus',''), 'day'),
       p_actor)
    returning id into v_student_id;

    if v_row ? 'guardian' and v_row->'guardian'->>'fullName' is not null then
      select id into v_guardian_id from public.guardians
      where tenant_id = p_tenant_id
        and phone is not null
        and phone = v_row->'guardian'->>'phone';

      if v_guardian_id is null then
        insert into public.guardians (tenant_id, full_name, phone, email)
        values (p_tenant_id, v_row->'guardian'->>'fullName',
                nullif(v_row->'guardian'->>'phone',''),
                nullif(v_row->'guardian'->>'email','')::citext)
        returning id into v_guardian_id;
      elsif nullif(v_row->'guardian'->>'email','') is not null then
        update public.guardians set email = (v_row->'guardian'->>'email')::citext
        where id = v_guardian_id and email is null;
      end if;

      insert into public.student_guardians (student_id, guardian_id, relationship, is_primary)
      values (v_student_id, v_guardian_id,
              coalesce(nullif(v_row->'guardian'->>'relationship',''), 'guardian'), true);
    end if;

    if nullif(v_row->>'classSectionId','') is not null then
      -- AUD-001: the section must belong to the importing tenant
      select id into v_section from public.class_sections
      where id = (v_row->>'classSectionId')::uuid and tenant_id = p_tenant_id;
      if v_section is null then
        raise exception 'IMPORT_SECTION_NOT_FOUND';
      end if;

      insert into public.class_enrolments
        (tenant_id, student_id, class_section_id, academic_year_id)
      values (p_tenant_id, v_student_id, v_section, p_year_id);
    end if;

    v_count := v_count + 1;
  end loop;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, after)
  values (p_tenant_id, p_actor, 'students.imported', 'student',
          jsonb_build_object('count', v_count));

  return jsonb_build_object('imported', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Financial records: immutable at the database level
-- ---------------------------------------------------------------------------
create or replace function app.block_financial_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'FINANCIAL_RECORDS_ARE_IMMUTABLE: % on % is not allowed — post a reversal instead',
    tg_op, tg_table_name;
end;
$$;

create trigger payments_immutable
  before update or delete on public.payments
  for each row execute function app.block_financial_mutation();
create trigger journal_entries_immutable
  before update or delete on public.journal_entries
  for each row execute function app.block_financial_mutation();
create trigger journal_lines_immutable
  before update or delete on public.journal_lines
  for each row execute function app.block_financial_mutation();
create trigger invoice_lines_immutable
  before update or delete on public.invoice_lines
  for each row execute function app.block_financial_mutation();

-- ---------------------------------------------------------------------------
-- 3. mark_attendance: serialise per (section, date) to remove the race on
--    the unique constraint. Function body otherwise unchanged from 0005.
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
  -- AUD-003: two concurrent submissions of the same register wait here
  -- instead of racing the unique constraint.
  perform pg_advisory_xact_lock(hashtext(p_class_section_id::text || p_date::text));

  if not exists (
    select 1 from public.class_sections
    where id = p_class_section_id and tenant_id = p_tenant_id
  ) then
    raise exception 'ATTENDANCE_SECTION_NOT_FOUND';
  end if;

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
