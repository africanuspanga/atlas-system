-- ATLAS migration 0001 — control plane, identity and access
--
-- Establishes the multi-tenant foundation:
--   tenants, campuses, settings, plans/subscriptions, feature flags,
--   profiles, memberships, roles, permissions, invitations, audit log.
--
-- Conventions:
--   * Every tenant-owned table carries tenant_id and has RLS enabled.
--   * The NestJS API connects with the service role (bypasses RLS) and
--     enforces permissions itself; RLS is the safety net for any direct
--     PostgREST/Realtime access from browsers and mobile apps.
--   * Financial and audit rows are never deleted; they are reversed or
--     superseded.

create extension if not exists "pgcrypto";
create extension if not exists "citext";

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Shared trigger: maintain updated_at
-- ---------------------------------------------------------------------------
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Control plane
-- ---------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug citext not null unique,
  status text not null default 'draft'
    check (status in ('draft','configuration','data_review','training','live','suspended','archived')),
  country text not null default 'TZ',
  region text,
  district text,
  address text,
  phone text,
  email citext,
  default_language text not null default 'en' check (default_language in ('en','sw')),
  currency text not null default 'TZS',
  timezone text not null default 'Africa/Dar_es_Salaam',
  logo_path text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger tenants_updated_at before update on public.tenants
  for each row execute function app.set_updated_at();

create table public.campuses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  name text not null,
  code text not null,
  is_main boolean not null default false,
  address text,
  status text not null default 'active' check (status in ('active','inactive')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create index campuses_tenant_idx on public.campuses (tenant_id);
create trigger campuses_updated_at before update on public.campuses
  for each row execute function app.set_updated_at();

create table public.tenant_settings (
  tenant_id uuid primary key references public.tenants(id),
  parent_language text not null default 'sw' check (parent_language in ('en','sw')),
  report_language text not null default 'en' check (report_language in ('en','sw')),
  invoice_language text not null default 'en' check (invoice_language in ('en','sw')),
  allow_user_language_override boolean not null default true,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create trigger tenant_settings_updated_at before update on public.tenant_settings
  for each row execute function app.set_updated_at();

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text,
  is_active boolean not null default true,
  monthly_price_tzs numeric(14,2),
  annual_price_tzs numeric(14,2),
  limits jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger plans_updated_at before update on public.plans
  for each row execute function app.set_updated_at();

create table public.plan_features (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id),
  feature_key text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  unique (plan_id, feature_key)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  plan_id uuid not null references public.plans(id),
  status text not null default 'trialing'
    check (status in ('trialing','active','past_due','suspended','cancelled')),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscriptions_tenant_idx on public.subscriptions (tenant_id);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function app.set_updated_at();

-- Tenant-level feature overrides (on top of plan features)
create table public.tenant_features (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  feature_key text not null,
  enabled boolean not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, feature_key)
);

create index tenant_features_tenant_idx on public.tenant_features (tenant_id);

-- ---------------------------------------------------------------------------
-- Identity and access
-- ---------------------------------------------------------------------------

-- One profile per auth user; global across tenants.
create table public.profiles (
  id uuid primary key references auth.users(id),
  full_name text not null default '',
  phone text,
  preferred_language text check (preferred_language in ('en','sw')),
  avatar_path text,
  platform_role text
    check (platform_role in ('super_admin','support','finance','implementation','auditor')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function app.set_updated_at();

create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.profiles(id),
  status text not null default 'invited'
    check (status in ('invited','active','suspended','revoked')),
  -- null means all campuses of the tenant
  campus_ids uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index tenant_memberships_tenant_idx on public.tenant_memberships (tenant_id);
create index tenant_memberships_user_idx on public.tenant_memberships (user_id);
create trigger tenant_memberships_updated_at before update on public.tenant_memberships
  for each row execute function app.set_updated_at();

-- Roles: system roles have tenant_id null; schools may define custom roles.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  key text not null,
  name text not null,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create unique index roles_system_key_idx on public.roles (key) where tenant_id is null;

create table public.permissions (
  key text primary key,
  description text not null default '',
  module text not null
);

create table public.role_permissions (
  role_id uuid not null references public.roles(id),
  permission_key text not null references public.permissions(key),
  -- scope: own | class | department | campus | tenant | platform
  scope text not null default 'tenant'
    check (scope in ('own','class','department','campus','tenant','platform')),
  primary key (role_id, permission_key)
);

create table public.membership_roles (
  membership_id uuid not null references public.tenant_memberships(id),
  role_id uuid not null references public.roles(id),
  assigned_at timestamptz not null default now(),
  assigned_by uuid references public.profiles(id),
  primary key (membership_id, role_id)
);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  email citext not null,
  role_keys text[] not null,
  campus_ids uuid[],
  token_hash text not null unique,
  status text not null default 'pending'
    check (status in ('pending','accepted','expired','revoked')),
  expires_at timestamptz not null,
  invited_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index invitations_tenant_idx on public.invitations (tenant_id);

-- ---------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id),
  campus_id uuid references public.campuses(id),
  actor_user_id uuid references public.profiles(id),
  actor_type text not null default 'user' check (actor_type in ('user','system','support')),
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  request_id text,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index audit_logs_tenant_time_idx on public.audit_logs (tenant_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (tenant_id, entity_type, entity_id);

-- Append-only: block updates and deletes at the database level.
create or replace function app.reject_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_logs is append-only';
end;
$$;

create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function app.reject_mutation();

-- ---------------------------------------------------------------------------
-- RLS helpers
-- ---------------------------------------------------------------------------
create or replace function app.is_tenant_member(target_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.campuses enable row level security;
alter table public.tenant_settings enable row level security;
alter table public.plans enable row level security;
alter table public.plan_features enable row level security;
alter table public.subscriptions enable row level security;
alter table public.tenant_features enable row level security;
alter table public.profiles enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.membership_roles enable row level security;
alter table public.invitations enable row level security;
alter table public.audit_logs enable row level security;

-- Members can see the tenants they belong to.
create policy "members read own tenants" on public.tenants
  for select using (app.is_tenant_member(id));

create policy "members read campuses" on public.campuses
  for select using (app.is_tenant_member(tenant_id));

create policy "members read tenant settings" on public.tenant_settings
  for select using (app.is_tenant_member(tenant_id));

create policy "members read tenant features" on public.tenant_features
  for select using (app.is_tenant_member(tenant_id));

-- Users manage their own profile.
create policy "own profile read" on public.profiles
  for select using (id = auth.uid());
create policy "own profile update" on public.profiles
  for update using (id = auth.uid());

-- Users see their own memberships.
create policy "own memberships read" on public.tenant_memberships
  for select using (user_id = auth.uid());

-- Roles/permissions are readable by members of the owning tenant;
-- system roles (tenant_id null) are readable by any signed-in user.
create policy "roles read" on public.roles
  for select using (tenant_id is null or app.is_tenant_member(tenant_id));

create policy "permissions read" on public.permissions
  for select using (auth.uid() is not null);

create policy "role permissions read" on public.role_permissions
  for select using (
    exists (
      select 1 from public.roles r
      where r.id = role_permissions.role_id
        and (r.tenant_id is null or app.is_tenant_member(r.tenant_id))
    )
  );

create policy "own membership roles read" on public.membership_roles
  for select using (
    exists (
      select 1 from public.tenant_memberships tm
      where tm.id = membership_roles.membership_id
        and tm.user_id = auth.uid()
    )
  );

-- Plans are public catalogue data for signed-in users.
create policy "plans read" on public.plans
  for select using (auth.uid() is not null);
create policy "plan features read" on public.plan_features
  for select using (auth.uid() is not null);

-- Subscriptions, invitations and audit logs are NOT exposed to end users
-- through PostgREST at all (no select policies) — the API mediates access.
