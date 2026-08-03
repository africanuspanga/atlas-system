# ATLAS Deep Bug Hunt - 2026-07-12

> **Historical record, superseded 3 August 2026.** Findings and evidence are
> preserved, but migration state, open/fixed status, commands, and launch
> verdict are not current. Use `docs/ATLAS_TESTING_GUIDE.md` and
> `docs/audit/GO_LIVE_READINESS_2026-08-03.md` operationally.

This report reviews the current working tree of the ATLAS school management SaaS for Tanzania. It is based on code inspection of the NestJS API, Next.js web app, worker processes, Supabase migrations/RLS/RPCs, and repo hygiene. I did not change product code. The only intended change from this review is this Markdown report.

## Verification Run

- `pnpm --filter @atlas/api typecheck` - passed.
- `pnpm --filter @atlas/web typecheck` - passed.
- `pnpm --filter @atlas/workers typecheck` - passed.
- `pnpm exec jest --runInBand` from `apps/api` - passed, 1 test suite / 1 test.
- I did not run lint because `apps/api/package.json` defines `lint` with `--fix`, which would modify source files.
- I did not run the live smoke scripts because they require a running API, Redis, Supabase project, and seeded environment.

## Severity Guide

- P0: likely platform compromise, privilege escalation, or direct cross-tenant access.
- P1: serious privacy, finance, payroll, or production communication failure.
- P2: important correctness or operational issue that can mislead users or corrupt workflow state.
- P3: hardening, hygiene, missing tests, or lower-probability issue.

## Executive Summary

The strongest parts of the codebase are the move toward service-role-only API mediation, the broad use of TenantGuard, and the newer RPC wrappers that revoke direct `anon`/`authenticated` execution. The biggest risks are not TypeScript/build issues; they are authorization boundaries, tenant invariants, SMS delivery, finance date logic, and payroll compliance controls.

Top items to fix first:

1. P0 - Users can likely self-assign `profiles.platform_role = 'super_admin'` through the Supabase client and gain platform admin powers.
2. P1 - Live schools will not have SMS outbox rows drained because the worker filters for a non-existent tenant status, `active`.
3. P1 - Parent portal and guardian notification flows trust `student_guardians` rows without a database same-tenant invariant; one bad link can expose or send data across tenants.
4. P1 - Payroll v1 computes PAYE on gross pay and has no settings verification path, so it should not be used for live payroll until corrected and reviewed.
5. P2 - Debtors "as of" reporting uses future payments and non-date-limited ledger totals, so historical receivable reports can be wrong.
6. P2 - Frontend pages always pick `tenants[0]`, which is not a safe SaaS tenant-selection model for multi-school users.

## Findings

### P0 - Platform self-escalation through editable `profiles.platform_role`

Evidence:

- `public.profiles` includes `platform_role` with values including `super_admin` in `supabase/migrations/00000000000001_control_plane.sql:152`.
- The RLS policy allows users to update their own profile row in `supabase/migrations/00000000000001_control_plane.sql:327`.
- `PlatformGuard` trusts `profiles.platform_role` for all `/platform` access and only requires `super_admin` for mutating platform state in `apps/api/src/platform/platform.guard.ts:36`.
- The local schema dump produced from the migration test database shows `GRANT ALL ON TABLE public.profiles TO authenticated`, so the RLS update policy is reachable through the Supabase client.

Impact:

Any authenticated user can likely update their own profile row to set `platform_role = 'super_admin'`, then call platform endpoints guarded by `PlatformGuard`. That can expose platform-wide metrics and tenant data, and can allow tenant suspension/reactivation/plan changes. This is a platform takeover class issue.

Recommended fix:

- Remove `platform_role` from the user-editable `profiles` table, or block client writes to it.
- Revoke table-level profile update from `anon` and `authenticated`, then grant update only on safe columns:

```sql
revoke update on public.profiles from anon, authenticated;
grant update (full_name, phone, preferred_language, avatar_path)
on public.profiles to authenticated;
```

- Add a database trigger that rejects changes to `platform_role` unless the change comes from a controlled service-role/platform-admin path.
- Add a smoke test that signs in as a normal school user, attempts `supabase.from("profiles").update({ platform_role: "super_admin" })`, and verifies it fails.

### P1 - Live tenants never drain SMS outbox

Evidence:

- Tenant statuses are `draft`, `configuration`, `data_review`, `training`, `live`, `suspended`, `archived` in `supabase/migrations/00000000000001_control_plane.sql:40`.
- Platform reactivation sets a tenant back to `live` in `apps/api/src/platform/platform.controller.ts:221`.
- The outbox worker only selects tenants whose status is `active` or `configuration` in `apps/workers/src/drain-outbox.ts:89`.
- `active` is not a valid tenant status.

Impact:

Production schools in `live` status will accumulate pending SMS rows for attendance, fee reminders, announcements, and clinic visits, but the drainer will not pick them up. Parent communication silently stops after a school reaches the intended live state.

Recommended fix:

- Replace the outbox status filter with allowed operational statuses, likely `configuration`, `data_review`, `training`, and `live`, or express the rule as "not suspended/archived/draft".
- Add a worker test with a `live` tenant and a pending outbox row.
- Include `/health/outbox` alerting for old pending rows segmented by tenant status.

### P1 - Imported Tanzanian phone numbers do not match Beem SMS format

Evidence:

- Import normalization converts `+255...` and `255...` numbers to local `0XXXXXXXXX` format in `apps/api/src/imports/import-domains.ts:244`.
- The Beem driver only strips a leading plus and then sends `dest_addr` in `apps/workers/src/sms-drivers.ts:47`.
- Beem's official SMS docs say `dest_addr` should be international format with country code and no leading plus, for example `255784825785`: https://docs.beem.africa/

Impact:

Even after the live-tenant status bug is fixed, many imported guardian numbers may be sent to Beem as `0712345678` rather than `255712345678`. That can cause SMS delivery failures or inconsistent gateway behavior.

Recommended fix:

- Store phone numbers in canonical E.164/international form for delivery, or keep local display format plus a separate normalized delivery field.
- Make the Beem driver convert `0XXXXXXXXX` to `255XXXXXXXXX` before sending.
- Add an integration/unit test for `+255712345678`, `255712345678`, and `0712345678`.

### P1 - Parent portal can expose cross-tenant child data if a bad guardian link exists

Evidence:

- `student_guardians` has only `student_id` and `guardian_id`; it has no `tenant_id` and no composite constraint proving the student and guardian belong to the same tenant in `supabase/migrations/00000000000004_students_guardians_invitations.sql:52`.
- `PortalController.linkedStudents()` returns `student_id` plus the guardian's `tenant_id` in `apps/api/src/parents/parents.controller.ts:81`.
- The portal then fetches the student by `id` only in `apps/api/src/parents/parents.controller.ts:107`.
- It also fetches invoices, payments, and attendance by `student_id` only in `apps/api/src/parents/parents.controller.ts:129`.
- These reads use the service-role client, so RLS will not save the endpoint if link data is malformed.

Impact:

Normal application paths may create correct links, but the database does not enforce it. A bad import, script, admin action, or future bug can link a guardian in one tenant to a student in another. The parent portal would then show the other school's student profile, balance, and attendance data.

Recommended fix:

- Add tenant filters to every portal follow-up read: `students.tenant_id = link.tenantId`, `invoices.tenant_id = link.tenantId`, `payments.tenant_id = link.tenantId`, and attendance via a tenant-scoped join/session.
- Add a same-tenant database invariant for `student_guardians`, either by adding `tenant_id` plus composite foreign keys or by using a trigger that rejects cross-tenant links.
- Add a regression test that intentionally creates a cross-tenant `student_guardians` row and verifies the portal refuses it.

### P1 - Attendance, fee, and clinic SMS can go to a guardian from the wrong tenant

Evidence:

- Attendance alert joins `students -> student_guardians -> guardians` but does not filter `guardians.tenant_id = p_tenant_id` in `supabase/migrations/00000000000010_audit_hardening.sql:211`.
- Fee reminders have the same missing guardian tenant filter in `supabase/migrations/00000000000009_parents.sql:202`.
- Clinic visit notification has the same missing guardian tenant filter in `supabase/migrations/00000000000023_clinic.sql:88`.
- Announcement SMS does filter `g.tenant_id = p_tenant_id` in `supabase/migrations/00000000000008_communication.sql:96`, which is the safer pattern.

Impact:

If a malformed `student_guardians` link exists, the system can send attendance absence, debt reminder, or clinic SMS to a guardian account from another school. This is both a privacy issue and a parent-trust issue.

Recommended fix:

- Add `and g.tenant_id = p_tenant_id` to every notification RPC.
- Fix the root schema invariant in `student_guardians`.
- Add SQL tests for all guardian notification RPCs.

### P1 - Payroll PAYE is computed on gross pay and there is no statutory settings workflow

Evidence:

- Payroll comments say schools must verify 2026-era Tanzania mainland defaults in `supabase/migrations/00000000000025_payroll.sql:14`.
- `app.run_payroll` computes `v_gross = basic + allowances`, then calls `app.compute_paye(v_gross, ...)` in `supabase/migrations/00000000000025_payroll.sql:283`.
- NSSF is computed after PAYE in `supabase/migrations/00000000000025_payroll.sql:285`.
- The TRA PAYE calculator states the input should be monthly pay after deducting NSSF/PSSSF: https://www.tra.go.tz/calculators/paye
- The payroll settings table exists in `supabase/migrations/00000000000025_payroll.sql:54`, but `apps/api/src/payroll/payroll.controller.ts` has no settings read/update endpoint, and `apps/web/src/app/payroll/payroll-view.tsx` has no settings verification screen.

Impact:

For a staff member with taxable pay above the thresholds, PAYE can be overstated if it should be calculated after employee NSSF/PSSSF deduction. Payroll is a compliance-sensitive module, so this should block live payroll use until a Tanzania payroll/accounting review confirms the correct taxable base and product flow.

Recommended fix:

- Add explicit payroll settings UI/API before the first payroll run.
- Add a `settings_verified_at`, `verified_by`, and effective-date model.
- Compute PAYE on the verified taxable base, not blindly on gross.
- Add calculator tests for representative salaries and compare against TRA's official calculator.
- Official references used for this review: TRA PAYE calculator (https://www.tra.go.tz/calculators/paye), TRA SDL page (https://www.tra.go.tz/page/skills-development-levy-sdl), NSSF contribution page (https://www.nssf.go.tz/pages/rate-of-contributions), HESLB repayment obligations (https://www.heslb.go.tz/loanrepayment/obligation), and WCF portal guidance (https://portal.wcf.go.tz/).

### P1 - Payroll employer liabilities are computed but not posted to the ledger

Evidence:

- Migration comments say employer-side NSSF, WCF, and SDL are informational only in `supabase/migrations/00000000000025_payroll.sql:26`.
- `post_payroll` posts gross salary expense, employee deductions, and net cash only in `supabase/migrations/00000000000025_payroll.sql:320`.
- The web UI displays employer NSSF/WCF/SDL as an informational note in `apps/web/src/app/payroll/payroll-view.tsx:624`.

Impact:

If the product is used as an accounting source of truth, employer statutory liabilities and employer payroll costs will be absent from journal entries. Finance users can understate expenses/liabilities even while the UI shows the amounts.

Recommended fix:

- Decide whether payroll v1 is a payslip calculator only or a full accounting posting module.
- If it is an accounting module, post employer statutory expense and liability lines.
- Add a payroll posting test that checks the journal includes both employee and employer obligations.

### P2 - Debtors "as of" report uses payments and ledger values after the as-of date

Evidence:

- `report_debtors(p_tenant_id, p_as_of)` accepts an as-of date in `supabase/migrations/00000000000017_instalments.sql:139`.
- It sums all payments for an invoice without `paid_on <= p_as_of` in `supabase/migrations/00000000000017_instalments.sql:150`.
- It also compares to all A/R journal lines without an entry date cutoff in `supabase/migrations/00000000000017_instalments.sql:143`.
- The API exposes this as a date-based debtors report in `apps/api/src/finance/finance.controller.ts:249`.

Impact:

Historical debtors reports can be wrong. If a parent paid after the selected as-of date, that future payment still reduces the past balance. This breaks month-end review, fee follow-up, and finance reconciliation.

Recommended fix:

- Filter payments by `paid_on <= p_as_of`.
- Join journal lines to journal entries and filter by `entry_date <= p_as_of`.
- Add tests for an invoice issued before the as-of date and a payment after the as-of date.

### P2 - Clinic date filters use UTC days instead of Tanzania local days

Evidence:

- Tenant timezone defaults to `Africa/Dar_es_Salaam` in `supabase/migrations/00000000000001_control_plane.sql:50`.
- Clinic visit filtering builds UTC day boundaries with `T00:00:00Z` and `T23:59:59.999Z` in `apps/api/src/clinic/clinic.controller.ts:68`.
- The AI clinic tool repeats the same UTC boundary pattern in `apps/api/src/ai/ai-tools.service.ts:1141`.

Impact:

Tanzania is UTC+3. A visit at 01:00 EAT belongs to the local day but is 22:00 UTC on the previous date. Daily clinic reports can miss early-morning visits or include next-day local visits.

Recommended fix:

- Convert date filters using `Africa/Dar_es_Salaam` local boundaries.
- Add tests around 00:00-03:00 EAT.
- Keep the AI tool and controller consistent.

### P2 - Frontend always selects `tenants[0]` with no tenant switcher or deterministic choice

Evidence:

- `AppShell` selects `tenants.limit(1)` and passes that tenant to the assistant in `apps/web/src/components/app-shell.tsx:20`.
- The dashboard also uses `tenants.limit(1)` in `apps/web/src/app/page.tsx:19`.
- Many pages repeat this pattern: `apps/web/src/app/students/page.tsx:16`, `apps/web/src/app/assistant/page.tsx:16`, `apps/web/src/app/timetable/page.tsx:28`, `apps/web/src/app/finance/page.tsx:22`, and others.
- There is no `order()` and no visible tenant switcher in the reviewed app shell.

Impact:

Multi-school owners, platform staff, or implementation/support users can be dropped into an arbitrary accessible tenant. They may view or mutate the wrong school's data because API calls use the selected tenant ID in `x-tenant-id`.

Recommended fix:

- Add a tenant selector and persist the selected tenant.
- Use deterministic fallback ordering when no tenant is selected.
- Make the assistant use the same selected tenant as the page, not its own `limit(1)` lookup.
- Add an E2E test for a user with two active tenant memberships.

### P2 - Fee item creation accepts cross-tenant grade and term IDs

Evidence:

- `createFeeItemSchema` accepts optional `gradeLevelId` and `academicTermId` UUIDs in `apps/api/src/finance/finance.schema.ts:16`.
- `createFeeItem` inserts those IDs without verifying they belong to the current tenant or active academic year in `apps/api/src/finance/finance.controller.ts:65`.
- The table FKs reference `grade_levels(id)` and `academic_terms(id)` only, not tenant-scoped composite keys, in `supabase/migrations/00000000000007_finance.sql:14`.

Impact:

A malformed request can store another tenant's grade or term ID in a fee item. That may not immediately leak data, but it corrupts fee applicability and becomes dangerous as fee automation grows.

Recommended fix:

- Validate `gradeLevelId` and `academicTermId` against `req.tenant.tenantId` before insert.
- Consider composite FKs or triggers for same-tenant references in finance tables.

### P2 - New module list endpoints silently return partial data when secondary queries fail

Evidence:

- Hostel checks `hostels.error` but ignores `allocations.error` in `apps/api/src/hostel/hostel.controller.ts:66`.
- Transport checks `routes.error` but ignores `assignments.error` in `apps/api/src/transport/transport.controller.ts:66`.
- Library checks `books.error` but ignores `loans.error` in `apps/api/src/library/library.controller.ts:95`.
- Inventory checks `items.error` but ignores `movements.error` in `apps/api/src/inventory/inventory.controller.ts:59`.

Impact:

During a Supabase query error or relationship/schema issue, the API can return plausible but false operational numbers: empty occupancy, zero route students, all books available, or zero inventory stock.

Recommended fix:

- Check every Supabase response's `error`.
- Prefer database views/RPCs for counts that must be consistent.
- Add tests that mock secondary-query failures and assert the endpoint returns a 500, not zeros.

### P2 - AI tools can also turn query failures into confident empty answers

Evidence:

- `getHostelOccupancy` ignores errors for both hostels and allocations in `apps/api/src/ai/ai-tools.service.ts:921`.
- `getTransportRoutes` ignores route/assignment errors in `apps/api/src/ai/ai-tools.service.ts:987`.
- `getLibraryOverdue` ignores the loan query error in `apps/api/src/ai/ai-tools.service.ts:1029`.
- `getInventoryStock` ignores item/movement errors in `apps/api/src/ai/ai-tools.service.ts:1086`.
- `getClinicVisits` ignores the visit query error in `apps/api/src/ai/ai-tools.service.ts:1135`.

Impact:

The assistant is instructed to answer from tools only, but these tools can report empty or incomplete data when a query failed. That makes the assistant confidently wrong in operational contexts.

Recommended fix:

- Fail closed on any Supabase `error`.
- Include `partial: true` only when partial results are intentionally supported.
- Add AI tool unit tests for failed Supabase responses.

### P2 - Platform mutations return success even if database writes fail

Evidence:

- `suspend` updates `tenants` but does not inspect the update error in `apps/api/src/platform/platform.controller.ts:204`.
- `reactivate` does the same in `apps/api/src/platform/platform.controller.ts:221`.
- `changePlan` and `extendTrial` also perform writes without checking every returned error in `apps/api/src/platform/platform.controller.ts:257` and `apps/api/src/platform/platform.controller.ts:303`.
- `audit()` inserts platform audit rows without checking insert failure in `apps/api/src/platform/platform.controller.ts:45`.

Impact:

The API can return `{ suspended: true }`, `{ reactivated: true }`, plan changed, or trial extended even when the database write failed. Platform staff may believe a tenant state changed when it did not, and audit trails can be missing.

Recommended fix:

- Check every Supabase write result.
- Move multi-step platform actions into RPCs or transactions.
- Add tests that force a Supabase write failure and verify the endpoint fails.

### P2 - Onboarding can create a tenant without a subscription if plan lookup/subscription insert fails

Evidence:

- Onboarding checks slug existence but does not handle the query error in `apps/api/src/onboarding/onboarding.controller.ts:40`.
- It looks up the `trial` plan and silently skips subscription creation if missing or errored in `apps/api/src/onboarding/onboarding.controller.ts:80`.
- `TenantGuard` then relies on entitlements from migrations 0013 onward.

Impact:

A school can complete onboarding but end up with missing subscription state. Depending on entitlement resolution, the new tenant may be immediately blocked or constrained unexpectedly.

Recommended fix:

- Treat missing `trial` plan or subscription insert failure as onboarding failure.
- Add a post-onboarding assertion that the tenant has exactly one valid subscription.

### P2 - Draft payroll can become stale after salary changes

Evidence:

- `run_payroll` snapshots active salary rows into `payroll_items` in `supabase/migrations/00000000000025_payroll.sql:278`.
- `set_staff_salary` can still deactivate and replace the salary after a draft run exists in `supabase/migrations/00000000000025_payroll.sql:199`.
- `post_payroll` posts the existing draft items without checking whether salary data changed after run creation in `supabase/migrations/00000000000025_payroll.sql:345`.

Impact:

A bursar can create a draft payroll run, change a salary, then post the stale draft. The posted ledger and displayed current salary setup diverge.

Recommended fix:

- Lock salary changes for a period with a draft run, or mark draft runs stale when salaries change.
- Add a salary snapshot hash or `salary_version` to payroll items.
- Warn/block posting when active salaries changed after run creation.

### P3 - Outbox drainer comments promise no message loss, but implementation is at-most-once

Evidence:

- Header comment says a crashed run never loses a message in `apps/workers/src/drain-outbox.ts:4`.
- The implementation marks the row `sent` before calling the SMS driver in `apps/workers/src/drain-outbox.ts:103`.
- Inline comment correctly says a crash between claim and send loses that message in `apps/workers/src/drain-outbox.ts:100`.

Impact:

This may be an intentional duplicate-billing tradeoff, but the file contradicts itself. For attendance/clinic/fees, a silently lost parent SMS can be serious.

Recommended fix:

- Decide product semantics: at-most-once, at-least-once, or idempotent provider send.
- Update comments and monitoring accordingly.
- If parent notification delivery matters more than duplicate risk, claim to an `in_progress` state and mark `sent` only after successful provider response.

### P3 - UUID validation is loose in security-sensitive request paths

Evidence:

- `TenantGuard` accepts `x-tenant-id` with `/^[0-9a-f-]{36}$/` in `apps/api/src/tenancy/tenant.guard.ts:70`.
- Parent report-card `termId` uses the same loose shape in `apps/api/src/parents/parents.controller.ts:196`.

Impact:

This does not by itself bypass membership checks, but it lets malformed UUID-looking strings reach database calls and creates inconsistent validation behavior.

Recommended fix:

- Use a real UUID v4/v7 parser or Zod UUID validation at boundaries.
- Share one UUID validation helper.

### P3 - `atlas-migration-test/pgdata` is an untracked Postgres data directory inside the repo

Evidence:

- `git status --short` shows `?? atlas-migration-test/`.
- `du -sh atlas-migration-test` reports about 67 MB.
- `rg --files atlas-migration-test` shows `pgdata`, WAL files, `postmaster.pid`, and a binary `schema.dump`.
- `.gitignore` does not ignore `atlas-migration-test/` in `.gitignore:17`.

Impact:

This can be accidentally committed, slow down searches, leak local database state, or confuse future reviewers. Even test databases can contain sensitive data if reused.

Recommended fix:

- Move local Postgres data outside the repo.
- Add `atlas-migration-test/` or at least `atlas-migration-test/pgdata/` to `.gitignore`.
- Keep only sanitized SQL dumps if the team needs committed fixtures.

### P3 - Seed data can diverge from migrations if used standalone

Evidence:

- `supabase/seed.sql` seeds only a `pilot` plan, while migration 0013 seeds `trial`, `msingi`, `kati`, and `juu`.
- Onboarding expects a `trial` plan in `apps/api/src/onboarding/onboarding.controller.ts:80`.
- Some newer permissions such as imports/reports are migration-seeded, not clearly seed-owned.

Impact:

If developers or CI use `seed.sql` as an authoritative seed without the full migration path, onboarding/roles/plans can behave differently from production.

Recommended fix:

- Make `seed.sql` either minimal demo data only or fully aligned with migrations.
- Add a local reset/test script that documents the supported order.

### P3 - Existing audit documents are stale relative to this working tree

Evidence:

- `docs/audit` contains prior reports that mark many issues fixed or low risk.
- The working tree currently has many modified and untracked modules: clinic, hostel, inventory, library, payroll, timetable, transport, migrations 0016-0025, platform/web changes, and worker outbox changes.

Impact:

Team members may rely on older audit summaries and miss current regressions introduced by active development.

Recommended fix:

- Treat this report as the current bug register for the active working tree.
- Move prior audits under a clearly dated archive section.
- Add a release checklist that updates the audit status before shipping.

## Security Notes That Look Good

These are not findings, but they are worth keeping:

- Most API controllers use `AuthGuard` and `TenantGuard` with per-route `@RequirePermission`.
- The web app uses `NEXT_PUBLIC_SUPABASE_ANON_KEY`, not the service-role key.
- Newer public RPC wrappers generally revoke direct `anon`/`authenticated` execution and grant only `service_role`.
- Payroll tables intentionally have no member-read RLS policy; API permissions mediate salary data.

## Suggested Fix Order

1. Lock down `profiles.platform_role` immediately.
2. Fix outbox status filtering and phone normalization before any live parent SMS use.
3. Add same-tenant constraints and tenant filters around guardian/student links.
4. Freeze live payroll usage until PAYE base, statutory settings, employer postings, and review workflow are corrected.
5. Correct debtors as-of logic.
6. Add a real tenant selector.
7. Fix secondary-query error handling in module dashboards and AI tools.
8. Clean repo hygiene and align seed/reset flows.

## Tests To Add

- A normal authenticated user cannot update `profiles.platform_role`.
- A live tenant with pending outbox rows sends SMS.
- Beem driver sends `255...` for locally entered/imported Tanzanian numbers.
- Cross-tenant `student_guardians` rows are impossible at the DB level and ignored by portal APIs.
- Debtors report excludes payments and journal entries after the as-of date.
- Clinic date filters use Africa/Dar_es_Salaam day boundaries.
- Multi-tenant user can choose tenant and all pages/API calls follow that selection.
- Payroll calculator examples match verified TRA/NSSF/HESLB/WCF/SDL expectations.
- Hostel/transport/library/inventory endpoints fail closed if secondary count queries fail.
