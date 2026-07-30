-- ATLAS migration 0028 — mobile device push tokens.
--
-- The mobile app (apps/mobile) registers each signed-in device's Expo push
-- token through the API (POST /api/v1/devices, AuthGuard only) so the
-- platform can later send push notifications. This migration only STORES
-- tokens; actually sending pushes (Expo Push API) is a future worker
-- concern — outbox-style, like the SMS outbox (0005).
--
-- Design notes:
--   * user_id references auth.users — parents/guardians authenticate but
--     hold NO tenant membership, so this table is deliberately outside the
--     tenant-membership model. tenant_id is optional routing context (which
--     school the device was signed into last), not an access-control key.
--   * expo_push_token is globally unique: a device token belongs to whoever
--     signed in last on that device — the API upserts on conflict and
--     re-points user_id/tenant_id (a shared phone must not keep receiving
--     the previous user's notifications).
--   * RLS enabled with NO policies = deny-all for anon/authenticated;
--     service-role/API only. House pattern for API-only tables (payroll
--     0025, ai_tool_calls/clinic_visits since 0027).
--
-- Additive-only: one new table, no changes to existing objects. No new
-- permission key — device registration is self-service for any
-- authenticated user (AuthGuard, no @RequirePermission), so seed.sql is
-- untouched. The permission layer blocks live-DB writes; the human applies
-- this with the handover loop (range {16..28}) or standalone:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/00000000000028_device_tokens.sql

create table public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  tenant_id uuid references public.tenants (id),
  expo_push_token text not null unique,
  platform text not null check (platform in ('ios', 'android')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

comment on table public.device_tokens is
  'Expo push tokens per signed-in mobile device. RLS deny-all: writes/reads via the API (service role) only. Sending pushes is a future worker concern.';
comment on column public.device_tokens.tenant_id is
  'Optional routing context (last tenant the device was signed into) — parents/guardians have no tenant membership, so this stays nullable.';
comment on column public.device_tokens.expo_push_token is
  'Globally unique: the API upserts on conflict, re-pointing user_id/tenant_id to the latest signer-in on the device.';
comment on column public.device_tokens.last_seen_at is
  'Touched on every re-registration; lets the future send worker drop stale tokens.';

-- The future send worker fans out by recipient.
create index device_tokens_user_idx on public.device_tokens (user_id);
create index device_tokens_tenant_idx on public.device_tokens (tenant_id)
  where tenant_id is not null;

-- Deny-all posture: RLS on, no policies — anon/authenticated see nothing,
-- the service-role API is the only path (payroll pattern, 0025).
alter table public.device_tokens enable row level security;
