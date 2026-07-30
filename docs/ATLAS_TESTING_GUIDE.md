# ATLAS — Testing & Verification Guide (go-to-market readiness)

_Last updated: 2026-07-12. Companion to `docs/ATLAS_DEEP_BUG_HUNT_2026-07-12.md`._

This guide is the checklist for verifying ATLAS is safe to sell to schools. It
covers: (1) what was fixed in the 2026-07-12 hardening pass and how to prove
each fix, (2) the database migration apply procedure, (3) automated test
suites, (4) per-role manual walkthroughs, and (5) the items that still need a
human decision before live use (payroll compliance, tenant switcher).

Work top-to-bottom. Nothing here should be skipped for a paying school.

---

## 0. TL;DR — the order to do things

1. **Shadow-test the migrations** (§2.1) — restore live data to a scratch DB,
   apply `0016`–`0026`, confirm clean. (Already done once on 2026-07-12; redo
   after any further migration edit.)
2. **Apply migrations 0016–0026 to the live dev DB** (§2.2). This is a
   human-only step — the assistant cannot write to the live DB.
3. **Run the full static gate** (§3.1): `pnpm turbo run lint typecheck test build`.
4. **Run every smoke suite** (§3.2) against a running API.
5. **Run the AI eval** (§3.3) — security categories must be 100%.
6. **Walk each role** (§4) in the browser.
7. **Run the regression checks for every fixed bug** (§5).
8. **Sign off the payroll-compliance and tenant-switcher decisions** (§6).

---

## 1. What was fixed on 2026-07-12

The deep bug hunt reported 20 findings; adversarial re-verification confirmed
**15 real** (5 were refuted — see §1.3) and surfaced **48 additional real
bugs**. All confirmed code-layer bugs were fixed; the schema fixes are split
between a new additive migration `0026` and in-place edits to the not-yet-applied
`0016`–`0025`.

### 1.1 Fixed in a NEW migration `0026_production_hardening.sql` (applied-schema)

These touch already-applied migrations (0001–0015), so they are additive-only in
`0026`:

| ID | Sev | Fix |
|----|-----|-----|
| BUG-01 | **P0** | `profiles.platform_role` self-escalation — `revoke update on profiles from anon, authenticated`, then column-grant UPDATE only on `full_name/phone/preferred_language/avatar_path`; recreate the update policy with a `WITH CHECK`. A normal user can no longer set themselves `super_admin`. |
| BUG-04 | P1 | `student_guardians` same-tenant trigger — rejects any link whose student and guardian are in different tenants. |
| BUG-INV | P2 | `invoices` immutability trigger — only `status` may change; header/total/student are frozen (matches the payments/journal iron rule). |
| BUG-SEAT | P2 | Staff-seat plan cap enforced in `app.accept_invitation` (was checked only at invite creation, bypassable). |
| BUG-AIX | P2 | `ai_proposed_actions` gains an `'executing'` status so confirm→execute can claim before running. |
| BUG-SMS-BACKOFF | P1 | `notification_outbox.next_attempt_at` column + index for retry backoff. |
| BUG-ASMT | P3 | `assessments` term/year trigger — a section and term from different academic years can’t be paired. |

### 1.2 Fixed in-place in unapplied migrations `0016`–`0025`

- **0016 timetable**: teacher-clash index made **UNIQUE** + `unique_violation`
  handler → race-proof double-booking guard (`TIMETABLE_TEACHER_CLASH`).
- **0017 instalments**: instalment amounts rounded to 2dp before the
  sum-equals-total check.
- **0019 hostel**: re-allocation now releases the student’s active bed in **any**
  year (not just the target year) so occupancy/capacity stay correct; new
  `hostel_occupancy(tenant)` aggregate RPC.
- **0020 transport**: new `transport_route_load(tenant)` aggregate RPC.
- **0022 inventory**: new `inventory_stock_levels(tenant)` aggregate RPC.
- **0025 payroll** (the big one):
  - **PAYE** now computed on the **taxable base = gross − employee NSSF**
    (TRA convention), not on gross. Verified: gross 650k → NSSF 65k → taxable
    585k → PAYE **33,000** (was 46,000).
  - **NSSF** (employee + employer) now assessed on **gross** (basic + allowances),
    not basic alone.
  - **Offboarding**: `deactivate_staff_salary` RPC + `run_payroll` now joins
    `tenant_memberships … status='active'`, so departed staff drop out.
  - **Draft void**: `discard_payroll_run` RPC frees a mistaken draft’s period.
  - **Stale-draft guard**: `post_payroll` raises `PAYROLL_RUN_STALE` if the draft
    no longer matches current active salaries.
  - **Settings/verification**: `payroll_settings` gains `verified_at/verified_by`;
    `update_payroll_settings` RPC; GET/PUT `/payroll/settings` API; a rates panel
    in the UI with an explicit “verified against TRA/NSSF/HESLB” stamp.

### 1.3 Code-layer fixes (no migration)

- **Workers**: outbox tenant-status filter fixed to `configuration/data_review/
  training/live` (BUG-02, was the invalid `'active'`); Beem `dest_addr` now
  converts local `0XXXXXXXXX` → `255XXXXXXXXX` (BUG-03); outbox retry backoff;
  poll-mode crash guard; report-job stale-claim recovery; import error-report
  pagination; honest at-most-once header comment.
- **API**: parent portal reads tenant-scoped (BUG-04 app side); AI read tools
  fail closed on query errors and use exact counts / aggregate RPCs instead of
  1000-row-capped JS tallies; AI confirm→execute claims `'executing'` before
  running and never mints super-roles / never persists plaintext invite tokens;
  module list endpoints check secondary-query errors; platform mutations check
  write errors; onboarding fails loudly if subscription provisioning fails;
  `createFeeItem` validates grade/term tenant ownership; finance money fields
  `.multipleOf(0.01)` + calendar-aware date validation; reversal race → stable
  400; clinic date filters use `Africa/Dar_es_Salaam` (+03:00); invitations block
  non-owners from minting `director` and pre-check pending-invite seat usage;
  rate-limiter `trust proxy`; payroll run-lookup error handling + new offboarding/
  discard/settings endpoints; NECTA CSV export neutralizes formula injection;
  academics/assessments endpoints check query errors + roster no longer truncates.
- **Web**: all pages tenant-scope their reads and select the tenant
  deterministically (oldest-first); dashboard/finance money totals paginate past
  the 1000-row cap; every mutation handler has try/catch/finally with a network
  error message; onboarding-wizard sequence bug; download/reminder/platform-view
  error surfacing; payroll UI for offboarding/discard/settings.

### 1.4 Refuted findings (NOT bugs — do not "fix")

`D05` (guardian-SMS tenant filter — safe because every writer scopes both sides
to one tenant and the new BUG-04 trigger now enforces it), `D07` (employer
statutory liabilities not posted — intentional, documented v1 scope), `D08`
(debtors "as-of" — it is an aged chase-list by design and is ledger-reconciled),
`D18` (loose UUID regex — fails closed to 403/400, no bypass), `D20`
(`seed.sql` plans — 0013 seeds are idempotent and run after migrations; module
permissions are mirrored). Evidence for each is in the bug-hunt report’s
verification notes.

---

## 2. Database migrations

Migrations `0016`–`0025` were already written/shadow-tested pre-hardening; the
hardening pass edited several of them in place and added `0026`. **All of
`0016`–`0026` still need to be applied to the live dev DB.**

### 2.1 Shadow test (do this before every live apply)

Per `docs/audit/ATLAS_RESTORE_RUNBOOK.md`. Validated on 2026-07-12 as follows
(a scratch Postgres 17 on port 5545 holding a live restore at the 0001–0015
boundary):

```bash
export PATH="/usr/local/opt/postgresql@17/bin:$PATH"
export LC_ALL=en_US.UTF-8          # else pg_ctl "became multithreaded" on macOS
# atlas_shadow = live restore at the 0001–0015 boundary
dropdb  -p 5545 -U postgres --if-exists atlas_verify
createdb -p 5545 -U postgres -T atlas_shadow atlas_verify
for f in supabase/migrations/000000000000{15,16,17,18,19,20,21,22,23,24,25,26}_*.sql; do
  psql -p 5545 -U postgres -d atlas_verify -v ON_ERROR_STOP=1 -f "$f" || { echo "FAILED $f"; break; }
done
```

Expected: every file prints `OK`. On 2026-07-12 the full chain `0015`→`0026`
applied clean, and these functional checks passed:

- `select app.compute_paye(585000, app.payroll_default_rates()->'paye_bands');`
  → `33000.00`.
- As role `authenticated`, `update public.profiles set platform_role='super_admin'`
  is **denied** (only the 4 safe columns are grantable).
- Triggers `student_guardians_same_tenant`, `invoices_financial_immutable`,
  `assessments_term_year_check` exist; RPCs `deactivate_staff_salary`,
  `discard_payroll_run`, `update_payroll_settings`, `hostel_occupancy`,
  `transport_route_load`, `inventory_stock_levels` exist.

> Note: a schema-only shadow can’t catch data-dependent seed problems; the
> full-restore shadow above does.

### 2.2 Apply to the live dev DB (human only — the assistant is blocked)

```bash
set -a && source .env && set +a
for f in supabase/migrations/000000000000{16..26}_*.sql; do
  /usr/local/opt/postgresql@17/bin/psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break
done
```

Then mirror any new permission keys check: none were added in `0026`
(payroll keys already live in `0025`/`seed.sql`).

### 2.3 One-time remediation after applying (data hygiene)

- **Invite tokens already leaked to storage** (BUG-AI token redaction): any AI
  `inviteStaff` proposals created before this pass stored the plaintext invite
  URL in `ai_proposed_actions.result` / `audit_logs.after`. Revoke those
  invitations (set `invitations.status='revoked'` for the affected rows) — the
  append-only audit table cannot be scrubbed, so revocation is the remedy.

---

## 3. Automated tests

### 3.1 Static gate (must be green)

```bash
pnpm turbo run lint typecheck test build
```

As of 2026-07-12 `typecheck`, `test`, and `build` are green across all 5
packages. (`lint` runs `--fix`; run it, then review the diff — eslint’s
`no-unnecessary-type-assertion` fixer strips `as` casts on Supabase results.)

### 3.2 Smoke suites (E2E — API must be running)

```bash
set -a && source .env && set +a
# start the API in one shell; then per module:
node apps/api/scripts/smoke-<module>.mjs
```

24 suites exist. The 10 newest — `timetable, instalments, necta, hostel,
transport, library, inventory, clinic, platform-metrics, payroll` — need
migrations `0016`–`0026` applied first. Onboarding is rate-limited (6/min/IP) —
space suites out or you’ll hit 429s.

**Smoke suites to update for the new behavior** (expected values changed):

- `smoke-payroll.mjs`: PAYE and NSSF figures changed. For basic 600k +
  allowances 50k (gross 650k): NSSF = 10%·650k = **65,000** (was 60,000 on
  basic); PAYE = compute_paye(650k−65k) = **33,000** (was 46,000 on gross);
  net and totals shift accordingly. Also add: deactivate a salary → next run
  excludes them; set a salary after a draft → `post` returns 400
  `PAYROLL_RUN_STALE`; `discard` a draft → same period can be re-run; discard a
  posted run → 400 `PAYROLL_RUN_POSTED`; GET/PUT `/payroll/settings`.
- `smoke-communication.mjs` / `smoke-attendance.mjs`: a **live** tenant with a
  pending outbox row now drains (previously only `configuration` drained). Add a
  case that flips a tenant to `live` and asserts drain.
- `smoke-hostel.mjs`: allocate across two academic years → prior bed released,
  occupancy correct.
- `smoke-finance.mjs`: POST a fee-item with another tenant’s `grade_level_id` →
  400 `FEE_ITEM_GRADE_NOT_FOUND`; a raw service-role UPDATE of `invoices.total`
  → `FINANCIAL_RECORDS_ARE_IMMUTABLE`.
- `smoke-instalments.mjs`: sub-cent instalment rows persist a schedule that sums
  to the total.

New behaviors worth a dedicated assertion (add where convenient): Beem MSISDN
conversion (`toMsisdn("0712345678") === "255712345678"`, exported from
`sms-drivers.ts`); attendance summary correct past 1000 records.

### 3.3 AI eval (real provider)

```bash
node apps/api/scripts/eval-ai.mjs      # security categories MUST be 100%
```

Re-run after the AI-tools/AI-actions changes. The tools now fail closed on DB
errors and use exact counts; confirm no eval regressions and that inviteStaff
can no longer propose a `director`.

---

## 4. Per-role manual walkthroughs (browser)

Preview: `pnpm --filter @atlas/web exec next start -p 3001`. Demo tenant
“Chief Sarwatt School” has all assessments published (marks locked by design)
and status `configuration`.

For a real go-to-market check, create a fresh tenant via onboarding and drive
each role end-to-end.

### 4.1 School Owner / Director (super-roles, bypass permission checks)
- Onboard a new school; confirm it lands with a `trial` subscription (if
  provisioning fails, onboarding now errors instead of half-creating — BUG-15).
- Dashboard money and counts reflect only THIS school (BUG tenant-scoping).
- Invite staff incl. a `director` (allowed for owners); confirm a non-owner
  cannot (below).
- Ask ATLAS (AI) to summarize the school; numbers must match the dashboard.

### 4.2 School Admin / Bursar / Accountant
- Invite a teacher — confirm inviting a `director` is **rejected**
  (`INVITE_ROLE_NOT_ALLOWED`) for non-owners (BUG privilege-escalation).
- Create fee items and invoices; record a payment; reverse it once (second
  reversal → clean `REVERSAL_ALREADY_REVERSED`, not a 500).
- Debtors report + send reminders; a network blip now shows an error, not a
  frozen dialog.
- **Payroll**: set salaries, run a draft, post it. Then: change a salary and
  try to post the old draft → `PAYROLL_RUN_STALE`; discard + re-run; remove a
  departed staff member and confirm the next run excludes them; open **Statutory
  rates**, review PAYE bands/NSSF/HESLB and click **Verify**.

### 4.3 Teacher
- Enter marks for an unpublished assessment; publish; confirm published marks
  lock. Create an assessment — a section+term from different years is rejected
  (`ASSESSMENT_TERM_YEAR_MISMATCH`).
- Timetable: assigning the same teacher to two sections in the same day+period
  is rejected (`TIMETABLE_TEACHER_CLASH`).

### 4.4 Parent (portal)
- Accept a parent invite; view children, balances, attendance, report card.
- Confirm you see ONLY your own child’s school data (BUG-04). (Cross-tenant
  exposure is now blocked at the DB by the same-tenant trigger and in the API by
  tenant-scoped reads.)

### 4.5 Platform staff (super_admin / support / …)
- A normal school user with NO `platform_role` gets 403 on `/platform`
  (unchanged) — and can no longer grant themselves one (BUG-01).
- Suspend/reactivate a tenant, change a plan, extend a trial — each now fails
  loudly if the DB write fails (BUG-14), and writes an audit row.
- Load the control centre with a forced error → an error banner shows, not a
  silently empty dashboard.

---

## 5. Regression matrix — prove each fixed bug

For each, the “Verify” column is the minimal repro that must now behave
correctly.

| Bug | Verify |
|-----|--------|
| BUG-01 platform_role | As `authenticated`, `supabase.from('profiles').update({platform_role:'super_admin'})` → denied. |
| BUG-02 outbox status | A `live` tenant with a pending outbox row drains on `drain-outbox --once`. |
| BUG-03 Beem MSISDN | `toMsisdn('0712345678') === '255712345678'`; `255…`/`+255…` unchanged. |
| BUG-04 portal tenant | A hand-inserted cross-tenant `student_guardians` row is now impossible (trigger) and the portal filters by tenant. |
| BUG-06 PAYE base | `compute_paye(gross−NSSF)` used; smoke figures updated. |
| BUG clinic dates | A visit at 01:00 EAT appears under the correct local day; a 23:30 UTC visit lands next EAT day. |
| BUG multi-tenant blend | A user in 2 schools sees only the selected (oldest by default) school’s data on every page. |
| BUG fee-item tenant | Cross-tenant `gradeLevelId`/`academicTermId` → 400. |
| BUG module errors | Force a secondary-query error on hostel/transport/library/inventory list → 500 with a stable code, not zeros. |
| BUG AI truncation | Seed >1000 attendance rows → `getAttendanceSummary` total is exact. |
| BUG platform writes | Force a `tenants` update error → suspend/reactivate returns 500, not `{suspended:true}`. |
| BUG onboarding sub | Force the plan lookup to fail → onboarding 500s and the tenant is archived, not left half-provisioned. |
| BUG payroll stale/offboard/discard | See §4.2. |
| BUG invite escalation | Non-owner inviting `director` → 403. |
| BUG seat cap | Create invites up to the plan’s staff limit incl. pending; the next accept → `PLAN_LIMIT_STAFF`. |
| BUG invoice immutable | Raw UPDATE of `invoices.total` → `FINANCIAL_RECORDS_ARE_IMMUTABLE`. |
| BUG timetable clash | Concurrent double-book → one wins, the other gets `TIMETABLE_TEACHER_CLASH`. |
| BUG CSV injection | Export NECTA candidates with a name starting `=` → the cell is prefixed with `'`. |
| BUG date validation | POST an invoice with `dueOn:'2026-02-31'` → 400, not 500. |
| BUG mutation freeze | Kill the API, submit any dialog → an error message shows and the button re-enables. |

---

## 6. Decisions that still need a human before live use

These are **not** unfixed bugs — they need a product/compliance owner, not code.

1. **Payroll statutory compliance (blocking for live payroll).** The PAYE
   taxable base (gross − employee NSSF) and the NSSF-on-gross base now follow the
   TRA/NSSF private-sector convention, and the app forces a “verified” stamp
   before the rates are trusted. **A Tanzanian payroll accountant must still
   confirm** the current band thresholds/rates and whether any school’s scheme is
   PSSSF (basic-base). Do not run live payroll for a school until its
   `payroll_settings` are verified. Employer NSSF/WCF/SDL remain **informational
   (not posted to the ledger)** — a documented v1 scope choice; decide if v1
   should post them before selling payroll as an accounting source of truth.

2. **Multi-school tenant switcher (P2, partially done).** Tenant selection is now
   deterministic (oldest membership-visible school) and every page/query is
   tenant-scoped, so a multi-school user no longer sees blended data. An
   **interactive switcher UI** to move between schools is **not yet built** — if
   any real customer owns >1 school in one account, build the switcher (cookie +
   sidebar dropdown) before onboarding them. Single-school accounts are fully
   correct today.

3. **Complex finance/academics RPC enhancements (deferred, shadow-test-heavy).**
   These were scoped out of the hardening pass because they rewrite
   already-applied finance/report RPCs and need their own careful shadow test;
   the boundary risks were mitigated at the API layer. Prioritize before scaling:
   - Invoice **void / credit-note** flow (today a mistaken invoice can only be
     corrected via payment reversal; there is no void). Money validation
     (`.multipleOf(0.01)`) and instalment rounding already landed.
   - **Backdated journal dates**: `post_journal` still stamps `current_date`;
     backdated payments disagree with the ledger date. (Debtors "as-of" is
     correct as an aged chase-list.)
   - `report_card` **class-position roster** (rank over the active roster incl.
     unscored students) and **A-Level points gate** (don’t show a CSEE best-7
     sum for A-Level).
   - `record_scores`/`publish_results` **publish-lock race** (`FOR UPDATE` on the
     assessment) — extremely narrow window; low priority.

4. **Plan-based module gating (P3).** `plan_features`/`tenant_features` scaffolding
   exists but nothing enforces it, so every plan currently includes every module
   (no revenue leakage today because no plan excludes a module). Add a
   `@RequireFeature` guard + seed the feature matrix when modules become
   plan-differentiated.

5. **Rate-limiter at horizontal scale (P3).** `trust proxy` is set so per-IP
   throttling is correct behind one proxy. If you run multiple API instances,
   wire a Redis-backed `ThrottlerStorage` so limits are shared across instances.

---

## 7. Go / no-go checklist

- [ ] Shadow test of `0015`–`0026` clean (§2.1).
- [ ] Migrations `0016`–`0026` applied to live (§2.2).
- [ ] Leaked invite tokens revoked (§2.3).
- [ ] `pnpm turbo run lint typecheck test build` green (§3.1).
- [ ] All 24 smoke suites green, including updated payroll/communication/hostel/
      finance/instalments assertions (§3.2).
- [ ] `eval-ai.mjs` security categories 100% (§3.3).
- [ ] All five roles walked (§4); regression matrix (§5) all pass.
- [ ] Payroll rates **verified** per tenant by a TZ accountant (§6.1).
- [ ] Tenant switcher built **iff** any customer owns >1 school (§6.2).
- [ ] `SMS_DRIVER=beem` + Beem creds set, and a real test SMS delivered to a
      `0…` number (proves BUG-03 end-to-end).
- [ ] `TRUST_PROXY` set to the real proxy hop count in production env.
