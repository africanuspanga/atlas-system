-- ATLAS migration 0003 — expose onboarding RPC through the public schema.
--
-- PostgREST only serves the public schema; app.* stays internal. This
-- wrapper is executable ONLY by the service role (the NestJS API) — never
-- by anon or authenticated clients.

create or replace function public.onboard_school(p_user_id uuid, p_payload jsonb)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select app.onboard_school(p_user_id, p_payload);
$$;

revoke execute on function public.onboard_school(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.onboard_school(uuid, jsonb) to service_role;
grant execute on function app.onboard_school(uuid, jsonb) to service_role;
