# ATLAS Administrator & Operator Guide

_Updated 2026-07-08. Audience: the ATLAS platform operator and school
administrators. For engineering conventions see the root `CLAUDE.md`; for
audit history see `docs/audit/`._

## 1. The platform at a glance

| Surface | URL path | Who |
|---|---|---|
| School dashboard | `/` (+ module pages) | School staff, by role |
| Parent portal | `/portal` | Guardians (non-member accounts) |
| ATLAS control centre | `/platform` | Platform staff only (`profiles.platform_role`) |
| AI assistant | `/assistant` | Any active school member (permission-scoped) |
| Data import wizard | `/imports` | Roles with `imports.manage` |
| Reports | `/reports` | Roles with `reports.generate` |

Services: Next.js web app, NestJS API (port 4000), background workers
(BullMQ + DB pollers), Supabase (Postgres + Auth + Storage), Redis.

## 2. Running the stack

```bash
pnpm install
set -a && source .env && set +a          # root .env holds all secrets

pnpm --filter @atlas/api dev             # API on :4000
pnpm --filter @atlas/web dev             # web on :3000
pnpm --filter @atlas/workers build       # then run the workers you need:
node apps/workers/dist/main.js           # BullMQ workers (needs Redis)
node apps/workers/dist/drain-outbox.js   # SMS outbox (no Redis needed)
node apps/workers/dist/process-imports.js
node apps/workers/dist/process-reports.js
```

Every worker also accepts `--once` (process what's pending, then exit) —
that's what the smoke tests use. BullMQ only accelerates pickup; the DB is
always the source of truth, so a Redis outage delays jobs but never loses
them.

## 3. Environments & configuration

All configuration lives in the root `.env` (`.env.example` documents every
key). Highlights:

- `SUPABASE_SERVICE_ROLE_KEY` — API/workers only. **Never** in the browser or
  in `NEXT_PUBLIC_*`.
- `WEB_ORIGIN` — must be set in production (invite links + CORS fail fast
  otherwise).
- `SMS_DRIVER` — `console` (dev) or `beem` (+ `BEEM_*` keys).
- `MOONSHOT_API_KEY` / `MOONSHOT_MODEL` — AI provider (`kimi-k2.6`;
  the model rejects non-default temperature, we send none).
- `AI_DRIVER=mock` — deterministic AI provider for tests only.
- `SENTRY_DSN` — set in production to activate error alerting.
- `ONBOARD_RATE_LIMIT` — per-IP tenant creations/minute (default 6).

## 4. Platform operations (control centre)

Platform staff are ordinary auth users with `profiles.platform_role` set
(`super_admin` acts; `support`/`finance`/`implementation`/`auditor` read).
Grant it via SQL only — it is never granted through the app:

```sql
update public.profiles set platform_role = 'super_admin' where id = '<user uuid>';
```

From `/platform` a super_admin can: view platform-wide metrics (schools,
students, MRR, SMS, failed jobs), suspend a school (written reason required —
all API access stops instantly), reactivate, change plans (caps and access
apply immediately), and extend trials. Every action is written to
`platform_audit_logs` **and** mirrored into the tenant's own audit log.

Subscriptions: onboarding auto-creates a 30-day trial. Enforcement is in the
API guard on every request — suspended → everything blocked; expired trial or
cancelled → writes blocked, reads stay open (a school is never locked away
from its own data). Plan caps (students, staff seats) are enforced at
creation and at bulk-import approval, not by hiding menus.

## 5. School onboarding & data migration

1. Operator (or school owner) registers and completes `/onboarding` —
   atomic: tenant, campus, academic year, terms, classes.
2. Import data at `/imports` (CSV/XLSX, English or Swahili headers):
   upload → map columns (suggestions + saved mappings) → **dry run** →
   review the error report → approve → the worker commits idempotently.
   Domains: students+guardians, opening balances (posted as invoices +
   journal entries against the Opening Balances equity account — never raw
   edits).
3. Follow `docs/audit/ATLAS_PILOT_RUNBOOK.md`: rehearse in staging, get the
   school's **written sign-off on totals**, then cut over.

## 6. Finance rules that operators must know

- Financial records are immutable at the database level. Corrections are
  reversals — never edits. This cannot be bypassed, even by the service role.
- Every invoice/payment/reversal posts a balanced journal entry.
- Reports **refuse to generate** if their figures don't reconcile to the
  ledger (`REPORT_RECONCILE_FAILED`) — treat any such failure as a P0 and
  investigate before retrying.

## 7. The AI assistant

Two layers, both permission-scoped to the asking user's role:

- **Read**: a fixed tool catalogue (counts, attendance, collections,
  outstanding fees, trial balance, student lookup). Financial tools call the
  same ledger-reconciled SQL as the reports, so AI numbers always match
  printed reports.
- **Actions**: the AI can *propose* — record a payment, issue an invoice,
  admit a student, invite staff, send an announcement, send fee reminders.
  Nothing executes until the human presses **Confirm** on the preview card
  (single-use, expires in 10 minutes, permission re-checked at confirmation).
  It can never: reverse/modify payments, change grades, publish results, run
  payroll, suspend accounts, delete anything, or change plans.

Every tool call and action is audited (`ai_tool_calls`,
`ai_proposed_actions`, `audit_logs`). Quality gate: `eval-ai.mjs` must stay
at 100% on security categories before any AI change ships.

## 8. Monitoring & health

Point uptime checks at (see `docs/audit/ATLAS_MONITORING.md`):

- `GET /api/v1/health` — API up
- `GET /api/v1/health/database` · `/health/redis` — dependencies
- `GET /api/v1/health/workers` — worker heartbeats + failed-job counts
- `GET /api/v1/health/outbox` — SMS backlog/failures (alert if `failed > 0`
  or oldest pending > 15 min)

Logs are structured JSON with `request_id` (echoed to clients as
`x-request-id` — ask a user reporting a bug for it). Set `SENTRY_DSN` for 5xx
alerting.

## 9. Backups, restore & release

- Restore procedure (tested 2026-07-08): `docs/audit/ATLAS_RESTORE_RUNBOOK.md`.
  Repeat quarterly. Delete dumps after testing — they contain real PII.
- Release gate: `pnpm turbo run lint typecheck test build` plus the full
  smoke suite (`apps/api/scripts/smoke-*.mjs`, 14 suites) and `eval-ai.mjs`.
  All migrations are additive; apply in order and record them in
  `supabase_migrations.schema_migrations`.
- Release readiness status: `docs/audit/ATLAS_RELEASE_READINESS.md`.

## 10. Demo school

"Chief Sarwatt School" (`chief-sarwatt`) is seeded for demos
(`apps/api/scripts/seed-demo.mjs`, idempotent). One-click demo login on the
login page; role accounts (`mwalimumkuu@`, `bursar@`, `mzazi@`… all
`@chiefsarwatt.sc.tz`) share the demo password in the seeder.
