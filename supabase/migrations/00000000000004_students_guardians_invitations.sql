-- ATLAS migration 0004 — students, guardians, enrolments, bulk import,
-- invitation acceptance.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.students (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  campus_id uuid references public.campuses(id),
  student_number text not null,
  first_name text not null,
  middle_name text,
  last_name text not null,
  gender text not null check (gender in ('male','female')),
  date_of_birth date,
  nationality text not null default 'TZ',
  boarding_status text not null default 'day' check (boarding_status in ('day','boarding')),
  status text not null default 'active'
    check (status in ('active','transferred','withdrawn','graduated','archived')),
  admission_date date not null default current_date,
  address text,
  photo_path text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, student_number)
);
create index students_tenant_idx on public.students (tenant_id, status);
create index students_name_idx on public.students (tenant_id, last_name, first_name);
create trigger students_updated_at before update on public.students
  for each row execute function app.set_updated_at();

create table public.guardians (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  full_name text not null,
  phone text,
  email citext,
  address text,
  occupation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index guardians_tenant_idx on public.guardians (tenant_id);
create unique index guardians_tenant_phone_idx on public.guardians (tenant_id, phone)
  where phone is not null;
create trigger guardians_updated_at before update on public.guardians
  for each row execute function app.set_updated_at();

create table public.student_guardians (
  student_id uuid not null references public.students(id),
  guardian_id uuid not null references public.guardians(id),
  relationship text not null default 'guardian'
    check (relationship in ('mother','father','guardian','sponsor','other')),
  is_primary boolean not null default false,
  primary key (student_id, guardian_id)
);

create table public.class_enrolments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  student_id uuid not null references public.students(id),
  class_section_id uuid not null references public.class_sections(id),
  academic_year_id uuid not null references public.academic_years(id),
  status text not null default 'active' check (status in ('active','completed','left')),
  enrolled_on date not null default current_date,
  created_at timestamptz not null default now(),
  unique (student_id, academic_year_id)
);
create index class_enrolments_tenant_idx on public.class_enrolments (tenant_id);
create index class_enrolments_section_idx on public.class_enrolments (class_section_id);

create table public.tenant_counters (
  tenant_id uuid not null references public.tenants(id),
  key text not null,
  value bigint not null default 0,
  primary key (tenant_id, key)
);

-- RLS
alter table public.students enable row level security;
alter table public.guardians enable row level security;
alter table public.student_guardians enable row level security;
alter table public.class_enrolments enable row level security;
alter table public.tenant_counters enable row level security;

create policy "members read students" on public.students
  for select using (app.is_tenant_member(tenant_id));
create policy "members read guardians" on public.guardians
  for select using (app.is_tenant_member(tenant_id));
create policy "members read student guardians" on public.student_guardians
  for select using (
    exists (select 1 from public.students s
            where s.id = student_guardians.student_id
              and app.is_tenant_member(s.tenant_id))
  );
create policy "members read class enrolments" on public.class_enrolments
  for select using (app.is_tenant_member(tenant_id));
-- tenant_counters: service role only, no policies.

-- ---------------------------------------------------------------------------
-- Counter helper
-- ---------------------------------------------------------------------------
create or replace function app.next_counter(p_tenant_id uuid, p_key text)
returns bigint
language sql
security definer
set search_path = public
as $$
  insert into public.tenant_counters (tenant_id, key, value)
  values (p_tenant_id, p_key, 1)
  on conflict (tenant_id, key) do update set value = tenant_counters.value + 1
  returning value;
$$;

-- ---------------------------------------------------------------------------
-- Bulk student import (also used for single creation with one row).
-- All-or-nothing: any bad row aborts the whole batch.
--
-- row shape: { firstName, middleName?, lastName, gender, dateOfBirth?,
--              boardingStatus?, classSectionId?, guardian?: { fullName,
--              phone?, relationship? } }
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
        insert into public.guardians (tenant_id, full_name, phone)
        values (p_tenant_id, v_row->'guardian'->>'fullName', nullif(v_row->'guardian'->>'phone',''))
        returning id into v_guardian_id;
      end if;

      insert into public.student_guardians (student_id, guardian_id, relationship, is_primary)
      values (v_student_id, v_guardian_id,
              coalesce(nullif(v_row->'guardian'->>'relationship',''), 'guardian'), true);
    end if;

    if nullif(v_row->>'classSectionId','') is not null then
      insert into public.class_enrolments
        (tenant_id, student_id, class_section_id, academic_year_id)
      values (p_tenant_id, v_student_id, (v_row->>'classSectionId')::uuid, p_year_id);
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
-- Invitation acceptance
-- ---------------------------------------------------------------------------
create or replace function app.accept_invitation(p_user_id uuid, p_email text, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv public.invitations%rowtype;
  v_membership_id uuid;
  v_role_key text;
  v_role_id uuid;
begin
  select * into v_inv from public.invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now();
  if v_inv.id is null then
    raise exception 'INVITE_INVALID_OR_EXPIRED';
  end if;
  if lower(v_inv.email::text) <> lower(p_email) then
    raise exception 'INVITE_EMAIL_MISMATCH';
  end if;

  insert into public.tenant_memberships (tenant_id, user_id, status, campus_ids)
  values (v_inv.tenant_id, p_user_id, 'active', v_inv.campus_ids)
  on conflict (tenant_id, user_id)
    do update set status = 'active', campus_ids = excluded.campus_ids
  returning id into v_membership_id;

  foreach v_role_key in array v_inv.role_keys
  loop
    select id into v_role_id from public.roles where tenant_id is null and key = v_role_key;
    if v_role_id is not null then
      insert into public.membership_roles (membership_id, role_id, assigned_by)
      values (v_membership_id, v_role_id, v_inv.invited_by)
      on conflict do nothing;
    end if;
  end loop;

  update public.invitations set status = 'accepted' where id = v_inv.id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
  values (v_inv.tenant_id, p_user_id, 'invitation.accepted', 'invitation', v_inv.id::text);

  return jsonb_build_object('tenantId', v_inv.tenant_id);
end;
$$;

-- Public wrappers — service role only.
create or replace function public.import_students(
  p_tenant_id uuid, p_actor uuid, p_campus_id uuid, p_year_id uuid, p_rows jsonb
)
returns jsonb language sql security definer set search_path = public
as $$ select app.import_students(p_tenant_id, p_actor, p_campus_id, p_year_id, p_rows); $$;

create or replace function public.accept_invitation(p_user_id uuid, p_email text, p_token_hash text)
returns jsonb language sql security definer set search_path = public
as $$ select app.accept_invitation(p_user_id, p_email, p_token_hash); $$;

revoke execute on function public.import_students(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.accept_invitation(uuid, text, text) from public, anon, authenticated;
revoke execute on function app.import_students(uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function app.accept_invitation(uuid, text, text) from public, anon, authenticated;
revoke execute on function app.next_counter(uuid, text) from public, anon, authenticated;
grant execute on function public.import_students(uuid, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.accept_invitation(uuid, text, text) to service_role;
