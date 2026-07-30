-- ATLAS migration 0027 — security polish.
--
-- Fixes from the 2026-07-16 production-readiness audit. Migrations are
-- additive-only, so every fix here is a new object, a `create or replace`,
-- a privilege change, a dropped over-broad RLS policy (tables stay
-- RLS-enabled — service-role/API-only, the payroll pattern), or an
-- idempotent data seed. Nothing edits or drops committed data.
--
-- Contents:
--   1. SEC-LEDGER (P1): deferred constraint trigger — journal entries must
--      balance (sum debits = sum credits, > 0 lines) at COMMIT, even if a
--      buggy service-role path bypasses app.post_journal.
--   2. SEC-FUNC (P2): app.account_for_method(text) missed 0007's revoke
--      sweep — verified live it is executable by anon/authenticated.
--   3. SEC-SEAT (P2): accept_invitation count-then-insert race on the staff
--      seat cap — two concurrent accepts could both read the same
--      pre-insert count. Serialise per tenant with an advisory xact lock.
--   4. SEC-AI (S1): ai_tool_calls / ai_usage_records had plain member-read
--      policies (0014), but tool-call ARGUMENTS can carry payment amounts
--      and clinic symptoms any teacher could read via direct PostgREST.
--      Reads go through the API only — drop the policies (deny-all).
--   5. SEC-CLINIC (P2): clinic_visits member-read policy (0023) let any
--      tenant member read health-visit details directly while the API
--      gates on clinic.view. Drop it (API-only reads, like payroll).
--   6. AI-QUOTA: seed per-plan monthly AI token caps in plans.limits
--      (jsonb key aiMonthlyTokens) for the per-tenant AI quota enforcement.
--
-- Ordering: apply immediately AFTER 0016-0026 in the same run — section 5
-- references clinic_visits (created in 0023). Shadow-test against a
-- live-data restore first (see ATLAS_RESTORE_RUNBOOK.md). The permission
-- layer blocks live-DB writes, so the human applies this with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/00000000000027_security_polish.sql

-- ---------------------------------------------------------------------------
-- 1. SEC-LEDGER (P1) — balanced-journal enforcement lives only inside
--    app.post_journal (0007). The service role can insert into journal_lines
--    directly, so a buggy future code path could post an unbalanced entry and
--    silently corrupt the ledger every report reconciles against. Add a
--    commit-time backstop in the database itself: a deferred constraint
--    trigger that re-checks every journal entry touched in the transaction.
--    Deferred (not immediate) because post_journal inserts lines one
--    statement at a time — the entry is only required to balance at COMMIT.
--    Existing rows are untouched (triggers fire on new changes only), and
--    every entry app.post_journal has ever written already satisfies it.
-- ---------------------------------------------------------------------------
create or replace function app.assert_journal_entry_balanced()
returns trigger
language plpgsql
as $$
declare
  v_entry_id uuid;
  v_debits numeric;
  v_credits numeric;
  v_lines bigint;
begin
  if tg_op = 'DELETE' then
    v_entry_id := old.entry_id;
  else
    v_entry_id := new.entry_id;
  end if;

  select coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*)
    into v_debits, v_credits, v_lines
  from public.journal_lines
  where entry_id = v_entry_id;

  if v_lines = 0 or v_debits <= 0 or v_debits <> v_credits then
    raise exception
      'LEDGER_UNBALANCED_ENTRY: journal entry % has % line(s), debits %, credits % at commit',
      v_entry_id, v_lines, v_debits, v_credits;
  end if;

  return null;
end;
$$;

comment on function app.assert_journal_entry_balanced() is
  'Commit-time backstop: every journal entry touched by a journal_lines change must have >0 lines and sum(debit)=sum(credit). Primary enforcement stays in app.post_journal.';

-- Fires once per changed line (entries are 2-6 lines; the recheck is an
-- indexed lookup via journal_lines_entry_idx). UPDATE/DELETE are already
-- blocked by 0010's immutability triggers — included here as defense in
-- depth. Note: an entry header inserted with NO lines at all is not caught
-- by this trigger (nothing fires); app.post_journal already rejects that
-- case (v_debits <= 0).
create constraint trigger journal_lines_entry_balanced
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function app.assert_journal_entry_balanced();

comment on trigger journal_lines_entry_balanced on public.journal_lines is
  'Deferred to COMMIT: asserts the affected journal entry balances (0027 SEC-LEDGER).';

-- ---------------------------------------------------------------------------
-- 2. SEC-FUNC (P2) — app.account_for_method(text) was created in 0007 but
--    missed that migration's revoke sweep (verified live: proacl is null, so
--    anon/authenticated inherit PUBLIC execute). It is a pure code-mapping
--    helper — no data exposure — but app.* functions are service-role-only by
--    convention; close the gap.
-- ---------------------------------------------------------------------------
revoke execute on function app.account_for_method(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. SEC-SEAT (P2) — accept_invitation (0026) enforces the staff-seat plan
--    cap with a count-then-insert: two invitees accepting concurrently under
--    one seat of headroom can BOTH read the same pre-insert count and both
--    get seats. Serialise acceptances per tenant with a transaction-scoped
--    advisory lock taken before the count; the lock releases automatically
--    at commit/rollback. Body is otherwise identical to 0026.
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
  v_guardian public.guardians%rowtype;
  v_staff_limit int;
  v_active_staff int;
begin
  select * into v_inv from public.invitations
  where token_hash = p_token_hash and status = 'pending' and expires_at > now();
  if v_inv.id is null then
    raise exception 'INVITE_INVALID_OR_EXPIRED';
  end if;
  if lower(v_inv.email::text) <> lower(p_email) then
    raise exception 'INVITE_EMAIL_MISMATCH';
  end if;

  -- Parent invite: link the guardian record, no tenant membership.
  if v_inv.guardian_id is not null then
    select * into v_guardian from public.guardians
    where id = v_inv.guardian_id and tenant_id = v_inv.tenant_id;
    if v_guardian.id is null then
      raise exception 'INVITE_GUARDIAN_NOT_FOUND';
    end if;
    if v_guardian.user_id is not null and v_guardian.user_id <> p_user_id then
      raise exception 'INVITE_GUARDIAN_TAKEN';
    end if;

    update public.guardians set user_id = p_user_id where id = v_guardian.id;
    update public.invitations set status = 'accepted' where id = v_inv.id;

    insert into public.audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
    values (v_inv.tenant_id, p_user_id, 'invitation.parent_linked', 'guardian', v_guardian.id::text);

    return jsonb_build_object('tenantId', v_inv.tenant_id, 'portal', 'parent');
  end if;

  -- Serialise concurrent staff acceptances per tenant so two accepts cannot
  -- both read the same pre-insert seat count (count-then-insert race,
  -- 0027 SEC-SEAT). Transaction-scoped: released at commit/rollback.
  perform pg_advisory_xact_lock(hashtext('seatcap:' || v_inv.tenant_id::text));

  -- Staff invite: enforce the plan's staff-seat cap, UNLESS this user is
  -- already an active member (re-accept must not be blocked — they are already
  -- counted). Null limit = unlimited.
  v_staff_limit := (app.tenant_entitlements(v_inv.tenant_id)->'limits'->>'staff')::int;
  if v_staff_limit is not null and not exists (
    select 1 from public.tenant_memberships
    where tenant_id = v_inv.tenant_id and user_id = p_user_id and status = 'active'
  ) then
    select count(*) into v_active_staff from public.tenant_memberships
    where tenant_id = v_inv.tenant_id and status = 'active';
    if v_active_staff + 1 > v_staff_limit then
      raise exception 'PLAN_LIMIT_STAFF';
    end if;
  end if;

  -- Staff invite: membership + roles.
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

  return jsonb_build_object('tenantId', v_inv.tenant_id, 'portal', 'staff');
end;
$$;

-- CREATE OR REPLACE preserves existing privileges in Postgres, so the 0004
-- grants survive — re-asserted here anyway so this file stands alone. The
-- public.accept_invitation wrapper (0004) still points at this function and
-- is untouched.
revoke execute on function app.accept_invitation(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.accept_invitation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.accept_invitation(uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. SEC-AI (S1) — 0014 gave ai_tool_calls and ai_usage_records plain
--    member-read policies, but tool-call ARGUMENTS jsonb can contain payment
--    amounts, debtor names and clinic symptoms that a teacher must not read
--    via direct PostgREST. The web app never reads these tables directly
--    (verified: no supabase-client references in apps/web/src) — all reads go
--    through the API (service role, permission-gated). Drop the policies:
--    RLS stays enabled with no policies = deny-all for members, service-role
--    only — the exact posture of the payroll tables (0025).
-- ---------------------------------------------------------------------------
drop policy if exists "members read ai tool audit" on public.ai_tool_calls;
drop policy if exists "members read ai usage" on public.ai_usage_records;

comment on table public.ai_tool_calls is
  'AI tool-call audit. RLS deny-all since 0027 (SEC-AI): arguments jsonb can carry finance/clinic data — reads via the API (service role) only.';
comment on table public.ai_usage_records is
  'AI token usage per tenant/conversation. RLS deny-all since 0027 (SEC-AI): reads via the API (service role) only.';

-- ---------------------------------------------------------------------------
-- 5. SEC-CLINIC (P2) — 0023's "members read clinic visits" policy let ANY
--    tenant member read symptoms/treatment/notes straight from PostgREST,
--    while the API gates the same data on clinic.view. The web clinic view
--    uses apiFetch only (verified: no direct supabase clinic reads in
--    apps/web/src). Drop the policy — clinic_visits becomes API-only, the
--    payroll pattern. Health data is the most sensitive PII we hold.
-- ---------------------------------------------------------------------------
drop policy if exists "members read clinic visits" on public.clinic_visits;

comment on table public.clinic_visits is
  'Clinic (zahanati) visit log. RLS deny-all since 0027 (SEC-CLINIC): health data — reads via the API (clinic.view) only.';

-- ---------------------------------------------------------------------------
-- 6. AI-QUOTA — per-tenant monthly AI token caps, read from
--    plans.limits->>'aiMonthlyTokens' by the AI quota enforcement (API).
--    Null/absent = unlimited, so seeding is what turns enforcement on.
--    Values scale with plan price (0013): trial 0 TZS → 500k tokens,
--    msingi 150k → 2M, kati 350k → 5M, juu 800k → 10M. 'pilot' (seeded by
--    seed.sql, no price — early-adopter schools up to 2500 students) gets
--    the kati-scale 5M; no-op here if the plan row does not exist yet.
--    Idempotent: only sets the key where it is absent, so operator overrides
--    survive re-runs. Mirrored in seed.sql for the pilot plan.
-- ---------------------------------------------------------------------------
update public.plans
set limits = jsonb_set(limits, '{aiMonthlyTokens}', to_jsonb(v.tokens), true)
from (values
  ('trial',    500000),
  ('msingi',  2000000),
  ('kati',    5000000),
  ('juu',    10000000),
  ('pilot',   5000000)
) as v(key, tokens)
where plans.key = v.key
  and not (plans.limits ? 'aiMonthlyTokens');
