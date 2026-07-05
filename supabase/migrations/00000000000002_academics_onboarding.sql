-- ATLAS migration 0002 — academic structure + atomic school onboarding
--
-- Adds academic_years, academic_terms, grade_levels, class_sections, a
-- profile-creation trigger for new auth users, and app.onboard_school():
-- one transactional function that creates tenant, settings, campus,
-- owner membership, academic year, terms, classes and the audit entry.

-- ---------------------------------------------------------------------------
-- Academic structure
-- ---------------------------------------------------------------------------
create table public.academic_years (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'active' check (status in ('draft','active','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name),
  check (ends_on > starts_on)
);

create index academic_years_tenant_idx on public.academic_years (tenant_id);
create trigger academic_years_updated_at before update on public.academic_years
  for each row execute function app.set_updated_at();

create table public.academic_terms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  academic_year_id uuid not null references public.academic_years(id),
  name text not null,
  sequence smallint not null,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  unique (academic_year_id, sequence),
  check (ends_on > starts_on)
);

create index academic_terms_tenant_idx on public.academic_terms (tenant_id);

-- Tanzanian levels: chekechea (pre-primary), darasa I-VII (primary),
-- form 1-4 (O-level), form 5-6 (A-level). International curricula map onto
-- the same structure with their own names.
create table public.grade_levels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  education_level text not null
    check (education_level in ('pre_primary','primary','o_level','a_level')),
  name text not null,
  sequence smallint not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index grade_levels_tenant_idx on public.grade_levels (tenant_id);

create table public.class_sections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  campus_id uuid not null references public.campuses(id),
  academic_year_id uuid not null references public.academic_years(id),
  grade_level_id uuid not null references public.grade_levels(id),
  -- stream name: "A", "B", "Blue"… single-stream schools use "A"
  name text not null,
  capacity smallint,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (academic_year_id, grade_level_id, name)
);

create index class_sections_tenant_idx on public.class_sections (tenant_id);
create index class_sections_year_idx on public.class_sections (academic_year_id);
create trigger class_sections_updated_at before update on public.class_sections
  for each row execute function app.set_updated_at();

-- RLS: members read; all writes go through the API (service role).
alter table public.academic_years enable row level security;
alter table public.academic_terms enable row level security;
alter table public.grade_levels enable row level security;
alter table public.class_sections enable row level security;

create policy "members read academic years" on public.academic_years
  for select using (app.is_tenant_member(tenant_id));
create policy "members read academic terms" on public.academic_terms
  for select using (app.is_tenant_member(tenant_id));
create policy "members read grade levels" on public.grade_levels
  for select using (app.is_tenant_member(tenant_id));
create policy "members read class sections" on public.class_sections
  for select using (app.is_tenant_member(tenant_id));

-- ---------------------------------------------------------------------------
-- Profile bootstrap: every new auth user gets a profile row
-- ---------------------------------------------------------------------------
create or replace function app.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_user();

-- Backfill profiles for any users created before this trigger existed.
insert into public.profiles (id, full_name)
select u.id, coalesce(u.raw_user_meta_data->>'full_name', '')
from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Atomic onboarding
-- ---------------------------------------------------------------------------
-- Called by the API (service role) after validating the payload. Everything
-- succeeds or nothing is written.
--
-- payload shape:
-- {
--   "school": { "name", "slug", "email", "phone"?, "region"?, "district"?,
--               "defaultLanguage": "en"|"sw" },
--   "academicYear": { "name", "startsOn", "endsOn",
--                     "terms": [{ "name", "startsOn", "endsOn" }] },
--   "classes": [{ "educationLevel", "gradeName", "sequence",
--                 "streams": ["A","B"] }]
-- }
create or replace function app.onboard_school(p_user_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_campus_id uuid;
  v_year_id uuid;
  v_role_id uuid;
  v_membership_id uuid;
  v_grade_id uuid;
  v_term jsonb;
  v_class jsonb;
  v_stream text;
  v_seq smallint := 0;
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'ONBOARDING_NO_PROFILE';
  end if;

  insert into public.tenants (name, slug, status, region, district, phone, email, default_language)
  values (
    p_payload->'school'->>'name',
    p_payload->'school'->>'slug',
    'configuration',
    p_payload->'school'->>'region',
    p_payload->'school'->>'district',
    p_payload->'school'->>'phone',
    p_payload->'school'->>'email',
    coalesce(p_payload->'school'->>'defaultLanguage', 'en')
  )
  returning id into v_tenant_id;

  insert into public.tenant_settings (tenant_id) values (v_tenant_id);

  insert into public.campuses (tenant_id, name, code, is_main)
  values (v_tenant_id, p_payload->'school'->>'name', 'MAIN', true)
  returning id into v_campus_id;

  insert into public.tenant_memberships (tenant_id, user_id, status)
  values (v_tenant_id, p_user_id, 'active')
  returning id into v_membership_id;

  select id into v_role_id from public.roles where tenant_id is null and key = 'school_owner';
  if v_role_id is null then
    raise exception 'ONBOARDING_MISSING_SYSTEM_ROLE';
  end if;

  insert into public.membership_roles (membership_id, role_id, assigned_by)
  values (v_membership_id, v_role_id, p_user_id);

  insert into public.academic_years (tenant_id, name, starts_on, ends_on)
  values (
    v_tenant_id,
    p_payload->'academicYear'->>'name',
    (p_payload->'academicYear'->>'startsOn')::date,
    (p_payload->'academicYear'->>'endsOn')::date
  )
  returning id into v_year_id;

  for v_term in select * from jsonb_array_elements(p_payload->'academicYear'->'terms')
  loop
    v_seq := v_seq + 1;
    insert into public.academic_terms (tenant_id, academic_year_id, name, sequence, starts_on, ends_on)
    values (
      v_tenant_id, v_year_id,
      v_term->>'name',
      v_seq,
      (v_term->>'startsOn')::date,
      (v_term->>'endsOn')::date
    );
  end loop;

  for v_class in select * from jsonb_array_elements(p_payload->'classes')
  loop
    insert into public.grade_levels (tenant_id, education_level, name, sequence)
    values (
      v_tenant_id,
      v_class->>'educationLevel',
      v_class->>'gradeName',
      (v_class->>'sequence')::smallint
    )
    returning id into v_grade_id;

    for v_stream in select jsonb_array_elements_text(v_class->'streams')
    loop
      insert into public.class_sections (tenant_id, campus_id, academic_year_id, grade_level_id, name)
      values (v_tenant_id, v_campus_id, v_year_id, v_grade_id, v_stream);
    end loop;
  end loop;

  insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id, after)
  values (v_tenant_id, p_user_id, 'tenant.onboarded', 'tenant', v_tenant_id::text,
          jsonb_build_object('name', p_payload->'school'->>'name', 'slug', p_payload->'school'->>'slug'));

  return jsonb_build_object('tenantId', v_tenant_id, 'campusId', v_campus_id, 'academicYearId', v_year_id);
end;
$$;

-- Only the service role may call this — revoke from client-facing roles.
revoke execute on function app.onboard_school(uuid, jsonb) from public, anon, authenticated;
