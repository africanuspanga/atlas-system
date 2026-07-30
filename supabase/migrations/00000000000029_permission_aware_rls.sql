-- ---------------------------------------------------------------------------
-- 0029 — permission-aware RLS, tenant-status gating, parent-membership backfill
--
-- Closes the access-control theme of the 2026-07-31 code review
-- (docs/audit/ATLAS_CODE_REVIEW_2026-07.md, THEME 2).
--
-- Three defects, one root cause: `app.is_tenant_member()` is the ONLY predicate
-- behind all 46 member-read policies, and it asks a single question —
-- "does this user hold an active membership row?". It never asks what the user
-- is allowed to see, and never asks whether the school is still entitled to
-- serve data. The API's @RequirePermission layer is therefore advisory only:
-- anything reachable through PostgREST with the public anon key ignores it.
--
--   SEC-029-A  Every tenant member reads all money and all guardian PII.
--              The `teacher` role is seeded with no finance.* and no
--              guardians.view, yet can read every invoice, payment, journal
--              entry, ledger line, guardian phone and guardian email directly
--              from the browser. /finance and /parents do exactly this, so the
--              leak is not theoretical — the pages render it.
--
--   SEC-029-B  Parents are tenant members with ZERO permissions.
--              The applied accept_invitation (0004:215) creates an active
--              membership for EVERY invite, including parent invites, and the
--              `parent` role falls through seed.sql's `else array[]::text[]`.
--              is_tenant_member() only checks the membership row, so a parent
--              — an untrusted external party — reads the entire school:
--              roster, DOBs, all guardians' contacts, the full fee ledger,
--              attendance, marks, and the SMS outbox.
--              0026 stops MINTING these memberships (guardian_id branch returns
--              before the insert) but never removes the ones already created,
--              so applying 0016-0028 alone leaves every parent who has already
--              accepted an invite with permanent full read of their school.
--              This migration backfills them.
--
--   SEC-029-C  Suspension and archival revoke nothing.
--              platform.controller suspend/archive flip `tenants.status` only.
--              is_tenant_member() never joins public.tenants, so every direct
--              browser and mobile read keeps working for a school that has
--              stopped paying or been shut down. TenantGuard blocks the API;
--              PostgREST does not.
--
-- Additive-only: no column or table is dropped; policies are replaced in place
-- and every helper keeps its original signature so dependent policies survive.
--
-- ATOMIC BY CONSTRUCTION. psql autocommits each statement unless told
-- otherwise, so a migration that drops a policy and then fails before
-- recreating it leaves that table with RLS enabled and NO policy — deny-all
-- for every end user, i.e. a silent outage that looks like "the data
-- disappeared". This file wraps itself in an explicit transaction so a failure
-- anywhere rolls the whole thing back. (Verified the hard way: an earlier
-- draft failed midway on a shadow cluster and left student_guardians
-- policy-less.) Migrations 0016-0028 have no such wrapper — apply them with
-- psql --single-transaction.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Backfill — retire permission-less parent/student memberships (SEC-029-B)
--
-- A membership is retired when it holds at least one role and EVERY role it
-- holds is 'parent' or 'student'. Staff memberships (any permission-bearing
-- role) and role-less memberships (mid-onboarding, or a custom-role tenant we
-- must not guess about) are left untouched.
--
-- 'revoked' rather than delete: tenant_memberships.id is referenced by
-- membership_roles and the row is audit-relevant. The parent portal reads
-- through the service role via guardians.user_id and is unaffected.
-- ---------------------------------------------------------------------------
do $$
declare
  v_retired int;
begin
  with permissionless as (
    select tm.id
    from public.tenant_memberships tm
    where tm.status = 'active'
      and exists (
        select 1 from public.membership_roles mr
        where mr.membership_id = tm.id
      )
      and not exists (
        select 1
        from public.membership_roles mr
        join public.roles r on r.id = mr.role_id
        where mr.membership_id = tm.id
          and coalesce(r.key, '') not in ('parent', 'student')
      )
  )
  update public.tenant_memberships tm
     set status = 'revoked', updated_at = now()
    from permissionless p
   where tm.id = p.id;
  get diagnostics v_retired = row_count;
  raise notice '0029: retired % permission-less parent/student membership(s)', v_retired;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

-- Membership check that ignores tenant status. Used ONLY for the control-plane
-- reads a locked-out school still needs in order to be told it is locked out
-- (the tenant row itself carries the status the shell renders).
create or replace function app.is_tenant_member_any_status(target_tenant uuid)
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

-- Same signature as before, so all 46 dependent policies keep working; now also
-- requires the school to be in a status that may serve data (SEC-029-C).
-- Mirrors TenantGuard, which rejects suspended and archived tenants.
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
    join public.tenants t on t.id = tm.tenant_id
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and t.status not in ('suspended', 'archived')
  );
$$;

-- Permission-aware membership check (SEC-029-A). Mirrors TenantGuard exactly:
-- SUPER_ROLES ('school_owner','director') bypass the permission lookup, and a
-- permission is held when ANY of the membership's roles grants the key.
create or replace function app.has_permission(target_tenant uuid, p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tenant_memberships tm
    join public.tenants t on t.id = tm.tenant_id
    join public.membership_roles mr on mr.membership_id = tm.id
    join public.roles r on r.id = mr.role_id
    where tm.tenant_id = target_tenant
      and tm.user_id = auth.uid()
      and tm.status = 'active'
      and t.status not in ('suspended', 'archived')
      and (
        r.key in ('school_owner', 'director')
        or exists (
          select 1 from public.role_permissions rp
          where rp.role_id = r.id and rp.permission_key = p_key
        )
      )
  );
$$;

revoke all on function app.is_tenant_member_any_status(uuid) from public;
revoke all on function app.has_permission(uuid, text) from public;
grant execute on function app.is_tenant_member_any_status(uuid) to authenticated;
grant execute on function app.has_permission(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Control plane — a suspended school must still be able to read its own
--    tenant row, or the web shell cannot explain the lockout.
-- ---------------------------------------------------------------------------
drop policy if exists "members read own tenants" on public.tenants;
create policy "members read own tenants" on public.tenants
  for select using (app.is_tenant_member_any_status(id));

-- ---------------------------------------------------------------------------
-- 4. Finance — money is readable only with the finance permissions the API
--    already demands on the equivalent endpoints (SEC-029-A).
--
--    Ledger internals (accounts, journal entries, journal lines) sit behind
--    finance.reports.view; billing documents sit behind finance.invoices.view.
--    Seeded effect: bursar/accountant/cashier keep their access, school_owner
--    and director keep everything, and teacher / class_teacher / head_teacher /
--    school_admin / academic_master / parent lose the direct-read leak.
-- ---------------------------------------------------------------------------
drop policy if exists "members read fee items" on public.fee_items;
create policy "members read fee items" on public.fee_items
  for select using (app.has_permission(tenant_id, 'finance.invoices.view'));

drop policy if exists "members read invoices" on public.invoices;
create policy "members read invoices" on public.invoices
  for select using (app.has_permission(tenant_id, 'finance.invoices.view'));

drop policy if exists "members read invoice lines" on public.invoice_lines;
create policy "members read invoice lines" on public.invoice_lines
  for select using (app.has_permission(tenant_id, 'finance.invoices.view'));

drop policy if exists "members read payments" on public.payments;
create policy "members read payments" on public.payments
  for select using (app.has_permission(tenant_id, 'finance.invoices.view'));

drop policy if exists "members read ledger accounts" on public.ledger_accounts;
create policy "members read ledger accounts" on public.ledger_accounts
  for select using (app.has_permission(tenant_id, 'finance.reports.view'));

drop policy if exists "members read journal entries" on public.journal_entries;
create policy "members read journal entries" on public.journal_entries
  for select using (app.has_permission(tenant_id, 'finance.reports.view'));

drop policy if exists "members read journal lines" on public.journal_lines;
create policy "members read journal lines" on public.journal_lines
  for select using (app.has_permission(tenant_id, 'finance.reports.view'));

-- Instalments arrive in 0017, which is applied before this migration.
drop policy if exists "members read invoice instalments" on public.invoice_instalments;
create policy "members read invoice instalments" on public.invoice_instalments
  for select using (app.has_permission(tenant_id, 'finance.invoices.view'));

-- ---------------------------------------------------------------------------
-- 5. Guardian PII — phone and email behind guardians.view (SEC-029-A).
--    "guardians read own row" (0009:19) is a separate, OR'd policy and is
--    deliberately left in place so a linked parent still reads their own row.
-- ---------------------------------------------------------------------------
drop policy if exists "members read guardians" on public.guardians;
create policy "members read guardians" on public.guardians
  for select using (app.has_permission(tenant_id, 'guardians.view'));

-- student_guardians is a pure link table with no tenant_id of its own; the
-- tenant is reached through the student, exactly as the 0004 policy did.
drop policy if exists "members read student guardians" on public.student_guardians;
create policy "members read student guardians" on public.student_guardians
  for select using (
    exists (
      select 1 from public.students s
      where s.id = student_guardians.student_id
        and app.has_permission(s.tenant_id, 'guardians.view')
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Roster — students behind students.view.
-- ---------------------------------------------------------------------------
drop policy if exists "members read students" on public.students;
create policy "members read students" on public.students
  for select using (app.has_permission(tenant_id, 'students.view'));

-- ---------------------------------------------------------------------------
-- 7. SMS outbox — payloads carry clinic treatment text (0023) and per-invoice
--    outstanding balances (0009), so a blanket member read defeated 0027's
--    clinic lockdown through the queue built from the same data.
-- ---------------------------------------------------------------------------
drop policy if exists "members read outbox" on public.notification_outbox;
create policy "members read outbox" on public.notification_outbox
  for select using (app.has_permission(tenant_id, 'communication.send'));

-- ---------------------------------------------------------------------------
-- 8. Report jobs — report_jobs.totals holds reconciled financial figures
--    (collected, trial-balance debits/credits, A/R outstanding) that the API
--    gates on reports.generate / finance.reports.view.
-- ---------------------------------------------------------------------------
drop policy if exists "members read report jobs" on public.report_jobs;
create policy "members read report jobs" on public.report_jobs
  for select using (app.has_permission(tenant_id, 'reports.generate'));

-- ---------------------------------------------------------------------------
-- 9. profiles.platform_role — defence in depth behind 0026 (BUG-01).
--
--    0026 closes the escalation by narrowing the UPDATE grant to four safe
--    columns. That is a privilege, and privileges are one careless
--    `grant all on all tables` away from being handed back. This trigger makes
--    the invariant a data rule instead: only the service role may ever change
--    platform_role, whatever the grants happen to say.
-- ---------------------------------------------------------------------------
-- NOTE: deliberately SECURITY INVOKER (the default). Inside a SECURITY DEFINER
-- function `current_user` is the function OWNER, not the caller, so the role
-- check below would compare 'postgres' against 'authenticated' and never fire —
-- the trigger would silently permit exactly what it exists to stop. Verified on
-- a shadow cluster: as SECURITY DEFINER the escalation succeeded.
create or replace function app.reject_platform_role_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Block only the two roles PostgREST hands to end users. Migrations run as
  -- `postgres`, and the API's service-role client as `service_role`; both must
  -- retain the ability to set the column or platform staff could never be
  -- provisioned.
  if new.platform_role is distinct from old.platform_role
     and current_user in ('anon', 'authenticated') then
    raise exception 'PLATFORM_ROLE_IMMUTABLE'
      using hint = 'platform_role is assigned by platform staff through the API only';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_platform_role_guard on public.profiles;
create trigger profiles_platform_role_guard
  before update on public.profiles
  for each row execute function app.reject_platform_role_change();

-- ---------------------------------------------------------------------------
-- 10. Indexes for the new predicates. has_permission runs per row on every
--     policy-checked read, so its joins must not sequentially scan.
-- ---------------------------------------------------------------------------
create index if not exists tenant_memberships_user_tenant_idx
  on public.tenant_memberships (user_id, tenant_id) where status = 'active';
create index if not exists membership_roles_membership_idx
  on public.membership_roles (membership_id);
create index if not exists role_permissions_role_key_idx
  on public.role_permissions (role_id, permission_key);

-- These three tables are now filtered by tenant_id on every policy-checked
-- read and had no tenant_id index at all: journal_lines (the trial balance's
-- reconciliation pre-check sequentially scanned every tenant's ledger),
-- notification_outbox (every per-tenant read plus the fee-reminder anti-join),
-- and ai_messages (the super-admin dashboard scanned it 2xN times per load).
create index if not exists journal_lines_tenant_idx
  on public.journal_lines (tenant_id);
create index if not exists notification_outbox_tenant_idx
  on public.notification_outbox (tenant_id, created_at desc);
create index if not exists ai_messages_tenant_idx
  on public.ai_messages (tenant_id, created_at desc);
create index if not exists student_guardians_guardian_idx
  on public.student_guardians (guardian_id);

commit;
