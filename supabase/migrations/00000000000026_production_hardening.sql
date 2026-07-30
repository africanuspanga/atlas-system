-- ATLAS migration 0026 — production hardening.
--
-- Fixes for issues found in the 2026-07-12 deep bug hunt whose root cause
-- lives in ALREADY-APPLIED migrations (0001-0015). Migrations are
-- additive-only, so every fix here is a new object, a `create or replace`,
-- an additive column, or a widened check constraint (existing rows always
-- satisfy the wider constraint). Nothing edits or drops committed data.
--
-- Contents:
--   1. BUG-01 (P0): lock down profiles.platform_role self-escalation.
--   2. BUG-04 (P1): student_guardians same-tenant invariant (trigger).
--   3. BUG-INV (P2): invoices immutability (only status may change).
--   4. BUG-SEAT (P2): staff-seat plan cap enforced at accept_invitation.
--   5. BUG-AIX (P2): ai_proposed_actions gains an 'executing' status.
--   6. BUG-SMS (P1): notification_outbox gains next_attempt_at for backoff.
--
-- Shadow-test against a live-data restore before applying (see
-- ATLAS_RESTORE_RUNBOOK.md). The permission layer blocks live-DB writes, so
-- the human applies this with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/00000000000026_production_hardening.sql

-- ---------------------------------------------------------------------------
-- 1. BUG-01 (P0) — profiles.platform_role self-escalation.
--
-- profiles has an "own profile update" RLS policy (0001) with no WITH CHECK,
-- and Supabase's default GRANT ALL to `authenticated` means any signed-in
-- user could set their own row's platform_role to 'super_admin' straight from
-- the browser client and seize PlatformGuard-protected endpoints. Revoke
-- table-wide UPDATE and re-grant it ONLY on the self-service columns, so the
-- privilege layer rejects any UPDATE that touches platform_role regardless of
-- RLS. The API uses the service-role key (bypasses grants) and is unaffected.
-- ---------------------------------------------------------------------------
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone, preferred_language, avatar_path)
  on public.profiles to authenticated;

-- Defense in depth: the update policy now also forbids changing id (the only
-- other sensitive column a column grant can't scope). Recreated with an
-- explicit WITH CHECK so the row must still belong to the caller afterwards.
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- 2. BUG-04 (P1) — student_guardians cross-tenant invariant.
--
-- student_guardians (0004) has no tenant_id and no constraint proving the
-- student and guardian belong to the same tenant. Every current writer scopes
-- both sides to one tenant, but the DB does not enforce it: a bad import,
-- script, or future bug could link a guardian in tenant A to a student in
-- tenant B, and the parent portal (service-role reads) would then expose the
-- other school's data. Reject such links at the source.
-- ---------------------------------------------------------------------------
create or replace function app.assert_student_guardian_same_tenant()
returns trigger
language plpgsql
as $$
begin
  if (select tenant_id from public.students  where id = new.student_id)
     is distinct from
     (select tenant_id from public.guardians where id = new.guardian_id) then
    raise exception
      'STUDENT_GUARDIAN_TENANT_MISMATCH: student % and guardian % are in different tenants',
      new.student_id, new.guardian_id;
  end if;
  return new;
end;
$$;

create trigger student_guardians_same_tenant
  before insert or update on public.student_guardians
  for each row execute function app.assert_student_guardian_same_tenant();

-- ---------------------------------------------------------------------------
-- 3. BUG-INV (P2) — invoices are not covered by the immutability triggers.
--
-- 0010 made payments, journal_entries, journal_lines and invoice_lines
-- immutable, but NOT the invoices header: total, student_id, invoice_number
-- etc. stayed mutable through the service role. Post the financial facts once
-- and never edit them; only the derived `status` (recomputed by record_payment
-- / reverse_payment) and the trigger-managed updated_at may change. Corrections
-- are voids/reversals, never edits.
-- ---------------------------------------------------------------------------
create or replace function app.block_invoice_financial_mutation()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'FINANCIAL_RECORDS_ARE_IMMUTABLE: DELETE on invoices is not allowed — void instead';
  end if;
  if new.tenant_id        is distinct from old.tenant_id
     or new.student_id       is distinct from old.student_id
     or new.academic_year_id is distinct from old.academic_year_id
     or new.academic_term_id is distinct from old.academic_term_id
     or new.invoice_number   is distinct from old.invoice_number
     or new.currency         is distinct from old.currency
     or new.total            is distinct from old.total
     or new.issued_on        is distinct from old.issued_on
     or new.due_on           is distinct from old.due_on
     or new.created_by       is distinct from old.created_by
     or new.created_at       is distinct from old.created_at then
    raise exception
      'FINANCIAL_RECORDS_ARE_IMMUTABLE: only invoices.status may change — post a reversal/void instead';
  end if;
  return new;
end;
$$;

-- Runs before invoices_updated_at (alphabetical order) and never inspects
-- updated_at, so the updated_at bump on a status change is still allowed.
create trigger invoices_financial_immutable
  before update or delete on public.invoices
  for each row execute function app.block_invoice_financial_mutation();

-- ---------------------------------------------------------------------------
-- 4. BUG-SEAT (P2) — staff-seat plan cap was checked only at invite creation
--    (against active memberships, which pending invites never increment), and
--    accept_invitation enforced nothing. N invites could be minted under one
--    seat of headroom and all accepted. Enforce the cap authoritatively at
--    acceptance. (The API also gains a pending-invite pre-check for fast
--    feedback; this is the backstop.) Body is otherwise identical to 0009.
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

-- ---------------------------------------------------------------------------
-- 5. BUG-AIX (P2) — ai_proposed_actions needs an 'executing' state so the
--    confirm→execute path can claim a proposal BEFORE running its RPC, then
--    flip to 'executed' only on success. Without it, confirm() marked a row
--    'executed' before executing, so an action could be recorded as done when
--    nothing ran. Widen the check (existing rows satisfy the wider set).
-- ---------------------------------------------------------------------------
alter table public.ai_proposed_actions
  drop constraint ai_proposed_actions_status_check;
alter table public.ai_proposed_actions
  add constraint ai_proposed_actions_status_check
  check (status in ('proposed','executing','executed','failed','rejected','expired'));

-- ---------------------------------------------------------------------------
-- 6. BUG-SMS (P1) — outbox retries had no backoff, so a brief SMS-provider
--    outage burned all 5 attempts of the entire pending backlog within
--    seconds and failed it permanently. Add a next_attempt_at gate the drainer
--    honours (fetch only rows due now; on failure push it forward
--    exponentially). Default now() so existing pending rows are due
--    immediately.
-- ---------------------------------------------------------------------------
alter table public.notification_outbox
  add column if not exists next_attempt_at timestamptz not null default now();
create index if not exists notification_outbox_due_idx
  on public.notification_outbox (next_attempt_at)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- 7. BUG-ASMT (P3) — an assessment could pair a class_section with an
--    academic_term from a DIFFERENT academic year. Marks entered under it then
--    silently vanish from report cards / CA summary (which join on the year).
--    Harmless today (one year per tenant) but a latent trap the moment a
--    year-rollover feature ships. Reject the mismatch at the source; the API
--    also returns a friendly 400 (ASSESSMENT_TERM_YEAR_MISMATCH) before this.
-- ---------------------------------------------------------------------------
create or replace function app.assert_assessment_term_year()
returns trigger
language plpgsql
as $$
begin
  if (select academic_year_id from public.class_sections where id = new.class_section_id)
     is distinct from
     (select academic_year_id from public.academic_terms where id = new.academic_term_id) then
    raise exception
      'ASSESSMENT_TERM_YEAR_MISMATCH: section % and term % are in different academic years',
      new.class_section_id, new.academic_term_id;
  end if;
  return new;
end;
$$;

create trigger assessments_term_year_check
  before insert or update of class_section_id, academic_term_id
  on public.assessments
  for each row execute function app.assert_assessment_term_year();
