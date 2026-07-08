# ATLAS Pilot School Runbook

_Added 2026-07-08 · Covers release-readiness items 20–21 (pilot data imported
in staging; school approves imported totals)._

Scope: a **controlled, operator-onboarded single-school pilot**. Self-serve
signup stays disabled until the platform layer ships.

## 0. Preconditions (all proven by automated checks)

- `pnpm turbo run lint typecheck test build` green.
- All smoke suites green (`apps/api/scripts/smoke-*.mjs`), including
  `smoke-isolation` and `smoke-health`.
- Staging restore test performed this quarter (ATLAS_RESTORE_RUNBOOK.md).
- Monitoring live: uptime checks on the four health endpoints + Sentry DSN set
  (ATLAS_MONITORING.md).

## 1. Staging rehearsal (before touching production)

1. Onboard the school in the **staging** environment via `/onboarding`
   (operator does this with the school's real structure: academic year, terms,
   classes/streams).
2. Collect the school's source files (students, guardians, opening balances —
   CSV/XLSX, any layout; the import pipeline maps columns).
3. Run each import through the staged pipeline: upload → map → validate →
   **dry-run** → review the error report with the school's registrar → correct
   at source → re-upload until the dry run is clean.
4. Commit the import. Save the import job ids.
5. Generate the verification pack for the school (reporting module):
   - Student register (per class) — headcount by class and gender.
   - Guardian contact list sample (registrar spot-checks 20 numbers).
   - Opening balances: per-student statement totals + the school-wide
     receivables total, reconciled to the ledger (`A/R = Σ opening invoices −
     Σ recorded historical payments`).
6. **School sign-off (human gate):** the head teacher and bursar sign the
   template below against the verification pack. No production import happens
   without both signatures.

## 2. Sign-off template

```text
ATLAS pilot data acceptance — <school name>
Import jobs: <ids>            Date: <date>
Students imported: <n>        (school records say: <n>)
Guardians imported: <n>
Opening receivables total: TZS <amount>   (school ledger says: TZS <amount>)
Discrepancies reviewed and accepted: <list or "none">
Head teacher: ____________   Bursar: ____________   ATLAS operator: ____________
```

## 3. Production cutover

1. Re-run the same import files against production (same pipeline, same
   mappings — mappings are saved per school).
2. Diff the production import summary against the signed staging summary; any
   mismatch aborts the cutover.
3. Enable SMS driver (`SMS_DRIVER=beem`) and send one test announcement to a
   staff-only group before parent-facing messages.
4. Hand over: demo login walkthrough, support contact, escalation path.

## 4. First-two-weeks watch list

- `/health/outbox` failed count (SMS delivery to real Tanzanian numbers).
- Attendance submission rate per class (missing registers = training gap).
- Unbalanced-day check: trial balance drawn daily; any imbalance is a P0.
- Sentry error rate; any 5xx spike investigated same-day.

## 5. Rollback

- Tenant-level: suspend the tenant (`tenants.status = 'suspended'`) — data
  intact, access blocked, SMS stops (outbox join excludes non-active tenants).
- Import-level: every imported record carries its `import_job_id`; the
  reversal path (never deletion) is: opening-balance invoices get credit
  reversals via the standard reversal RPC, preserving the audit trail.
- Code-level: redeploy previous tag; migrations are additive-only.
