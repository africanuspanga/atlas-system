-- ATLAS migration 0023 — clinic (zahanati) module.
--
-- The school clinic/dispensary logs student visits (symptoms, treatment,
-- notes). Boarding schools notify parents by SMS after treatment: when the
-- recorder asks for it, an SMS to the student's primary guardian is queued in
-- public.notification_outbox IN THE SAME TRANSACTION as the visit (the exact
-- pattern of migration 0005's absence alerts); the workers app drains the
-- outbox and renders the Kiswahili text. Writes go through
-- app.record_clinic_visit only.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.clinic_visits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  student_id uuid not null references public.students(id),
  visited_at timestamptz not null default now(),
  symptoms text not null,
  treatment text,
  notes text,
  notify_guardian boolean not null default false,
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index clinic_visits_tenant_idx
  on public.clinic_visits (tenant_id, visited_at desc);
create index clinic_visits_student_idx on public.clinic_visits (student_id);

-- RLS: members read; all writes via the API (service role).
alter table public.clinic_visits enable row level security;

create policy "members read clinic visits" on public.clinic_visits
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Record a clinic visit. When p_notify is true, ONE SMS row is queued for the
-- student's primary guardian with a phone number — same transaction, same
-- outbox the attendance absence alerts use. Returns whether an SMS was
-- actually queued (a notify request for a student without a reachable
-- guardian records the visit but returns notified=false).
-- ---------------------------------------------------------------------------
create or replace function app.record_clinic_visit(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid,
  p_symptoms text, p_treatment text, p_notes text, p_notify boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit_id uuid;
  v_queued int := 0;
begin
  if p_symptoms is null or trim(p_symptoms) = '' then
    raise exception 'CLINIC_SYMPTOMS_REQUIRED';
  end if;

  if not exists (
    select 1 from public.students
    where id = p_student_id and tenant_id = p_tenant_id and status = 'active'
  ) then
    raise exception 'CLINIC_STUDENT_NOT_FOUND';
  end if;

  insert into public.clinic_visits
    (tenant_id, student_id, symptoms, treatment, notes, notify_guardian, created_by)
  values (p_tenant_id, p_student_id, trim(p_symptoms),
          nullif(trim(p_treatment), ''), nullif(trim(p_notes), ''),
          coalesce(p_notify, false), p_actor)
  returning id into v_visit_id;

  if coalesce(p_notify, false) then
    -- SMS to the primary guardian with a phone — same shape as the
    -- attendance.absent alerts in migration 0005.
    insert into public.notification_outbox (tenant_id, recipient, template, payload)
    select p_tenant_id, g.phone, 'clinic.visit',
           jsonb_build_object(
             'studentId', s.id,
             'studentName', s.first_name || ' ' || s.last_name,
             'studentNumber', s.student_number,
             'guardianName', g.full_name,
             'treatment', nullif(trim(p_treatment), ''),
             'schoolName', t.name,
             'visitId', v_visit_id
           )
    from public.students s
    join public.student_guardians sg on sg.student_id = s.id and sg.is_primary
    join public.guardians g on g.id = sg.guardian_id and g.phone is not null
    join public.tenants t on t.id = p_tenant_id
    where s.id = p_student_id
    limit 1;
    get diagnostics v_queued = row_count;
  end if;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (p_tenant_id, p_actor, 'clinic.visit_recorded', 'clinic_visit',
          v_visit_id::text,
          jsonb_build_object('studentId', p_student_id,
                             'notifyRequested', coalesce(p_notify, false),
                             'notified', v_queued > 0));

  return jsonb_build_object('visitId', v_visit_id, 'notified', v_queued > 0);
end;
$$;

-- Public wrapper — service role only (PostgREST exposes only public schema).
create or replace function public.record_clinic_visit(
  p_tenant_id uuid, p_actor uuid, p_student_id uuid,
  p_symptoms text, p_treatment text, p_notes text, p_notify boolean
)
returns jsonb language sql security definer set search_path = public
as $$ select app.record_clinic_visit(p_tenant_id, p_actor, p_student_id, p_symptoms, p_treatment, p_notes, p_notify); $$;

revoke execute on function app.record_clinic_visit(uuid, uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.record_clinic_visit(uuid, uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.record_clinic_visit(uuid, uuid, uuid, text, text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Permissions (keys BEFORE role_permissions — FK). Mirrored in seed.sql.
-- school_owner/director are superusers in the API guard and need no rows.
-- A dedicated nurse role can come later.
-- ---------------------------------------------------------------------------
insert into public.permissions (key, module, description) values
  ('clinic.view',   'clinic', 'View clinic visits'),
  ('clinic.manage', 'clinic', 'Record clinic visits and notify guardians')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select r.id, p.key
from public.roles r
cross join lateral unnest(case r.key
  when 'teacher'       then array['clinic.view']
  when 'class_teacher' then array['clinic.view']
  when 'head_teacher'  then array['clinic.view', 'clinic.manage']
  when 'school_admin'  then array['clinic.view', 'clinic.manage']
  else array[]::text[]
end) as p(key)
where r.tenant_id is null and r.is_system
on conflict do nothing;
