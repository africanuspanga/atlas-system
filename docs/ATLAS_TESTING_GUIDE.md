# ATLAS testing and verification guide

_Current through migration `0033` · updated 3 August 2026._

This is the release checklist for a controlled pilot. Historical audit reports
explain how bugs were found; this file describes how the current system must be
verified. Do not run mutating smoke/eval scripts against a customer production
database after launch—use an isolated staging project.

## 1. Required order

1. Install from the lockfile and scan dependencies.
2. Run quality gates sequentially.
3. Rehearse the complete migration chain in scratch Postgres.
4. Run the high-risk transactional SQL regression.
5. Inspect the remote migration dry run and apply only missing migrations.
6. Run all 25 API/database smoke suites in staging.
7. Run the real-provider AI evaluation.
8. Walk owner, finance, teacher, parent, and platform roles manually.
9. Complete infrastructure, privacy, payroll, SMS, backup, and school sign-off.

## 2. Static quality and supply-chain gates

Next route generation/build and TypeScript use `.next`; keep these stages
sequential to avoid a generated-type race.

```bash
pnpm install --frozen-lockfile
pnpm --filter @atlas/web exec next typegen
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level moderate
git diff --check
```

Verified on 3 August 2026: lint 3/3, typecheck 7/7, unit tests 4/4,
API/workers/web builds 3/3, and no known moderate-or-higher vulnerability.
The small unit layer is not treated as sufficient evidence; the live-connected
suites carry most workflow coverage today.

## 3. Database verification

### Full migration rehearsal

Requires PostgreSQL 17 at `/usr/local/opt/postgresql@17/bin` by default. Set
`PGBIN` if installed elsewhere.

```bash
./scripts/shadow-migrations.sh
```

Expected: migrations `0001`–`0033`, 71 public tables, 60 RLS policies, 217
app/public functions, and no unintended RLS-enabled table with zero policies.
A schema-only shadow cannot prove a backfill against existing rows, so use an
access-controlled restore for every data-dependent migration.

### High-risk transactional regression

`scripts/go-live-regression.sql` ends with `ROLLBACK`. It asserts atomic
onboarding/trial creation, owner-metric scoping, payroll verification/employer
journals, PAYE validation, Tanzania payroll dates, A-Level aggregation,
payment idempotency, and payment-date rules.

```bash
SHADOW_MAX_VERSION=33 ./scripts/shadow-migrations.sh --keep
/usr/local/opt/postgresql@17/bin/psql \
  -h /tmp/atsh -p 55432 -U postgres -d atlas_shadow \
  -v ON_ERROR_STOP=1 -f scripts/go-live-regression.sql
/usr/local/opt/postgresql@17/bin/pg_ctl -D .shadow/data stop -m fast
```

Success prints `BEGIN`, `DO`, `ROLLBACK` and exits zero.

### Linked Supabase project

Never rerun an arbitrary numeric range with a manual psql loop. Rehearse, then
use migration history:

```bash
set -a && source .env && set +a
pnpm exec supabase db push --dry-run --include-all
pnpm exec supabase db push --include-all
```

Verify the latest `supabase_migrations.schema_migrations` row afterward. The
audited linked project is currently at `00000000000033`.

## 4. API/database smoke suites

These scripts create auth users and tenants, mutate the configured Supabase
project, and archive their test tenants. Run them only in staging or during an
explicitly approved production-readiness exercise.

Start the API with deterministic AI and a test-only onboarding allowance:

```bash
cd apps/api
set -a && source ../../.env && set +a
AI_DRIVER=mock ONBOARD_RATE_LIMIT=1000 pnpm start
```

In a second shell, run these 24 suites:

`ai-actions`, `ai`, `assessments`, `attendance`, `clinic`, `communication`,
`finance`, `health`, `hostel`, `imports`, `instalments`, `inventory`,
`isolation`, `library`, `lifecycle`, `necta`, `onboarding`, `parents`,
`payroll`, `platform-metrics`, `reports`, `students`, `timetable`, `transport`.

```bash
cd apps/api
set -a && source ../../.env && set +a
node scripts/smoke-<suite>.mjs
```

Restart the API without `ONBOARD_RATE_LIMIT=1000`, then run
`node scripts/smoke-platform.mjs`; it verifies the default onboarding burst
returns `429`.

Current result: **25/25 passed**. Coverage includes onboarding, RBAC/RLS,
students/guardians, attendance, assessments, finance/ledger, parent portal,
communication/outbox, imports, reports, platform lifecycle/metrics, AI actions,
timetable, instalments/debtors, NECTA, hostel, transport, library, inventory,
clinic, payroll, health, lifecycle, and cross-tenant attacks.

If interrupted, a suite may leave a tenant named `Smoke …`. Inspect it before
changing anything; archive only clearly identified test tenants and revoke
their memberships. Never bulk-delete tenants.

## 5. Real-provider AI gate

Restart the API without `AI_DRIVER=mock`, with real Moonshot credentials, then:

```bash
cd apps/api
set -a && source ../../.env && set +a
node scripts/eval-ai.mjs
```

Release bars:

- unauthorized, cross-tenant, injection, and action-security cases all pass;
- no proposal executes before explicit human confirmation;
- no salary or clinical-detail disclosure;
- overall pass rate is at least 80%, with security categories at 100%.

Verified 3 August 2026: **40/40**, security categories 100%, mean latency
17,461 ms, 388,805 tokens. Re-run after any model, prompt, tool, permission,
or confirmation-flow change, and track latency/cost as well as correctness.

## 6. Tenant/RBAC attack matrix

Use distinct users and schools. Never test RLS as the service role or Postgres
superuser because both bypass it.

| Actor                    | Must succeed                               | Must fail                              |
| ------------------------ | ------------------------------------------ | -------------------------------------- |
| Owner/director           | authorized workflows within own school     | another tenant; platform-role mutation |
| Accountant/bursar        | granted finance/report/payroll operations  | another tenant; platform lifecycle     |
| Cashier                  | granted payment receipt flow               | reversal/payroll unless granted        |
| Teacher                  | assigned academic/attendance/student views | finance, payroll, unrelated guardians  |
| Class teacher            | class-scoped students/attendance/guardians | unrelated classes and finance          |
| Parent                   | own guardian row and linked children       | roster, other children, staff APIs     |
| Platform support/auditor | allowed aggregate/audit reads              | platform mutations                     |
| Platform super-admin     | audited lifecycle/plan/payment actions     | self-grant from ordinary session       |

Minimum database assertions: linked parent sees zero unlinked students/invoices;
pure teacher sees assigned students and zero finance/guardian rows; finance sees
only its tenant; anon/authenticated cannot update `profiles.platform_role`; no
unintended RLS-enabled table has zero policies.

## 7. Manual acceptance

### Owner and finance

- Complete atomic onboarding, confirm the 30-day trial, and switch between two
  authorized schools without mixed data.
- Create invoice/instalments, receive a payment, retry it, and confirm one
  receipt. Reject future/pre-invoice payments. Reverse without deleting history.
- Reconcile dashboard, debtors, trial balance, printed report, and AI answer.
- Confirm payroll blocks unverified rates; after accountant approval, post and
  reconcile separate wage and employer-contribution journals.

### Teacher, academic leader, and parent

- Mark/correct attendance according to role; enter/publish/lock results; test
  timetable clashes and NECTA/A-Level outputs.
- Confirm teachers cannot access finance/payroll by URL or API.
- Parent sees only linked children, own-child balances/attendance, and published
  results; another student's id is denied.

### Platform and field conditions

- Test support read-only and super-admin audited actions on synthetic tenants.
- Confirm archived tenants/historical subscriptions do not inflate operational
  MRR, headcounts, SMS, imports, or report failures.
- Test keyboard/screen reader/reduced motion/printing/browsers, physical iOS and
  Android, low-bandwidth retries, and secure session persistence.
- Send real Beem SMS to Vodacom, Airtel, Yas, and Halotel test numbers and
  reconcile delivery. Console output is not delivery proof.

## 8. Final go/no-go checklist

- [ ] Quality and supply-chain gates pass from a clean checkout.
- [ ] Full shadow and high-risk SQL regression pass.
- [ ] Target database reports migration `0033`.
- [ ] 25/25 staging smokes pass; no active `Smoke …` tenant remains.
- [ ] Real-provider AI security is 100%; latency/cost accepted.
- [ ] Web, API, queue worker, and outbox drainer deploy together.
- [ ] HTTPS, health token, Sentry, Redis, Moonshot, and Beem are configured.
- [ ] Health/heartbeats/alerts and current-schema restore are tested.
- [ ] PDPC/DPA/privacy/cross-border AI sign-off is complete.
- [ ] Pilot-school payroll settings are professionally verified.
- [ ] Imported totals are signed by the head teacher and bursar.
- [ ] Real SMS and role/device/browser acceptance pass.
- [ ] First school runs in `training` before promotion to `live`.

See the [current go-live decision](audit/GO_LIVE_READINESS_2026-08-03.md).
