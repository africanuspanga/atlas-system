-- 0036 — let the API read SMS usage.
--
-- 0035's public.tenant_sms_usage wrapper admitted tenant MEMBERS only. The API
-- holds the service-role key and is not a member of any tenant, so the admin
-- used/remaining counter and the 80% warning — the whole reason the function
-- exists — got SMS_USAGE_FORBIDDEN.
--
-- The drainer was never affected: app.claim_notification calls app.tenant_sms_usage
-- directly, inside the app schema, and does not pass through this wrapper.
--
-- The service role bypasses RLS everywhere in ATLAS by design and does its own
-- tenant scoping in TenantGuard, so admitting it here is consistent with the
-- rest of the system rather than a new hole. Member access is unchanged, and
-- anon is still refused.

begin;

create or replace function public.tenant_sms_usage(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app
as $$
declare
  v_role text;
begin
  -- The caller's JWT role, not current_user: this is SECURITY DEFINER, so
  -- current_user is the function owner and would never identify the caller.
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
    ''
  );

  if v_role <> 'service_role' and not app.is_tenant_member(p_tenant_id) then
    raise exception 'SMS_USAGE_FORBIDDEN';
  end if;

  return app.tenant_sms_usage(p_tenant_id);
end;
$$;

revoke all on function public.tenant_sms_usage(uuid) from public, anon;
grant execute on function public.tenant_sms_usage(uuid) to authenticated, service_role;

commit;
