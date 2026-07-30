# ATLAS — engineering conventions & handover

Tanzania-first multi-tenant school SaaS. pnpm + Turborepo monorepo:
`apps/web` (Next.js 16, App Router), `apps/api` (NestJS 11, port 4000),
`apps/workers` (BullMQ + standalone DB pollers), `apps/mobile` (Expo SDK 57 +
expo-router native iOS/Android app — see its README for dev/EAS),
`packages/i18n` (shared EN+SW dictionaries — web re-exports it, keep key
sets mirrored), `supabase/migrations`.
Operator/role docs: `docs/ADMIN_GUIDE.md`. Audit history/specs: `docs/audit/`.
Sales/GTM: `docs/sales/` (playbook + founding-schools offer, EN+SW).
Visual language: `design.md` at repo root (Atlas Blue #0052ff, Inter +
JetBrains Mono, pill buttons, 24px cards) — consult before any UI work.
Local preview: web runs on **port 3001** (`pnpm --filter @atlas/web exec next
start -p 3001`) — the user keeps another process on 3000.

## Module map (what exists, by migration)

0001 control plane (tenants/roles/permissions/audit) · 0002-0003 onboarding +
academic structure · 0004 students/guardians/enrolments/invitations ·
0005 attendance + SMS outbox · 0006 subjects/grading/assessments/report cards ·
0007 finance (invoices/payments/ledger — immutable) · 0008 communication ·
0009 parent portal · 0011 imports · 0012 report jobs (ledger-reconciled) ·
0013 platform (plans/subscriptions/entitlements) · 0014 AI assistant ·
0015 AI actions (propose→confirm→execute) · 0016 timetable · 0017 fee
instalments + debtors report · 0018 NECTA (A-Level combinations, CA summary,
candidate export) · 0019 hostel · 0020 transport · 0021 library ·
0022 inventory · 0023 clinic (+ guardian SMS) · 0024 platform metrics (super
dashboard RPCs) · 0025 payroll (PAYE bands jsonb, posts to ledger) ·
0026 production hardening (profiles.platform_role lockdown, student_guardians
same-tenant trigger, invoices immutability, accept_invitation seat cap,
ai_proposed_actions 'executing' state, outbox next_attempt_at backoff,
assessments term/year trigger — see docs/ATLAS_TESTING_GUIDE.md) ·
0027 security polish (deferred ledger-balance constraint trigger,
account_for_method revoke, seat-cap advisory lock, ai_tool_calls/ai_usage
+ clinic_visits policies dropped to API-only reads, plans gain
`aiMonthlyTokens` quota) · 0028 device_tokens (mobile push registration,
deny-all RLS, API-only via POST/DELETE /devices).

## HANDOVER (2026-07-17, branch `audit/production-readiness`, uncommitted)

**Where things stand:** three waves done this session, all uncommitted on
this branch:
1. **Production audit + fix wave** — tenant isolation verified sound
   (~180 query sites), platform subscription lifecycle built (plan cycles,
   record-payment, archive, audit viewer, lapse enforcement), web launch
   fixes (RPC trial balance, roster search/pagination, route-aware shell,
   EN+SW error maps), AI catalogue at 28 tools / 17 actions with per-plan
   token quotas, migration 0027 security polish.
2. **Docs wave** — `docs/ADMIN_GUIDE.md` start-to-finish walkthrough,
   `docs/sales/` GTM playbook + founding-schools offer (EN+SW).
3. **Mobile wave** — native iOS/Android app at `apps/mobile` (Expo SDK 57,
   expo-router, NOT a WebView): login, dashboard, students, attendance,
   finance, Ask ATLAS chat with propose→confirm cards, parent portal,
   settings; shared `packages/i18n` extracted (web re-exports it,
   `transpilePackages` in next.config); push-notification plumbing
   (`src/lib/notifications.ts` + `POST/DELETE /devices` + migration 0028);
   EAS profiles + generated brand assets + `apps/mobile/README.md`.

**Verified:** turbo gate 14/14 green (now includes mobile lint/typecheck +
i18n typecheck; web untouched and passing). Live smokes green for
everything migrations 0001–0015 support: smoke-platform (incl. the new
subscription lifecycle), smoke-finance, smoke-ai, smoke-students,
smoke-attendance, smoke-assessments. Mobile: `expo export` bundles both
platforms (Hermes .hbc), `expo-doctor` 20/20, dev server serves the iOS
manifest.

**THE ONE GATE — migrations 0016–0028 are written but NOT applied to the
live dev Supabase project.** 0026 closes a **live P0** (any signed-in user
can self-promote via `profiles.platform_role`). The permission layer blocks
agents from applying DDL; the human must run (note `{16..28}` — the old
`{16..25}` command skipped the P0 fix):
`set -a && source .env && set +a && for f in supabase/migrations/000000000000{16..28}_*.sql; do /usr/local/opt/postgresql@17/bin/psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f" || break; done`

**Post-apply checklist, in order:**
1. Start the API (`AI_DRIVER=mock`) and run the 10 new module smokes PLUS
   `smoke-communication` and `smoke-ai-actions` — both fail pre-0026
   (outbox `next_attempt_at`; ai_proposed_actions `'executing'` state).
2. Restart the API with the real provider and run `eval-ai.mjs`
   (security categories must be 100%).
3. Commit the sprint. Until applied, new module pages render but their API
   calls fail on missing tables (and mobile push registration 500s —
   `device_tokens` arrives with 0028; the app degrades gracefully).
4. Mobile one-timers (human, interactive): `npx eas-cli login && eas init`
   inside `apps/mobile` (sets `extra.eas.projectId` — required before push
   tokens and EAS builds), then `eas build`/`eas submit` per the README.

**Backlog after the gate (priority order):** renewal-reminder outbox job
(endpoints exist, nothing sends T-14/T-7 SMS) · enforce the `smsMonthly`
cap (metered, unenforced) · failed-SMS drill-down list · AI error/latency
columns on `ai_usage_records` + the promised 90-day `ai_messages` purge
worker · ARR/churn/LTV metrics snapshot table · support impersonation
(spec: `docs/audit/ATLAS_OWNER_DASHBOARD_AUDIT.md`) · payment gateway
webhooks (`docs/product/PAYMENTS_INTEGRATION_PLAN.md`) · student portal ·
marketing site. GTM/sales material lives in `docs/sales/`.

## Iron rules

- **Business logic lives in NestJS + Postgres (RPCs/constraints), never in
  React.** The web app renders and calls the API; simple reads may use
  Supabase RLS directly.
- **Tenant scoping is server-side, always.** The API uses the service-role
  key (bypasses RLS) — every query MUST filter by `tenant_id` from
  `TenantGuard` context (`x-tenant-id` header → membership check →
  entitlements → permissions). RLS is the safety net, not the control.
- **Financial records are immutable** (DB triggers). Corrections are
  reversals. Every money movement posts a balanced journal entry. Report SQL
  reconciles to the ledger and raises `REPORT_RECONCILE_FAILED` on mismatch.
- **Migrations are additive-only**, numbered `000000000000NN_name.sql`
  (currently 0001–0028; one sanctioned exception: 0025 widened
  `journal_entries_source_type_check` to admit `'payroll'` — existing rows
  unaffected). New `app.*` functions get service-role-only
  `public.*` wrappers (PostgREST exposes only `public`), with explicit
  `revoke`/`grant`. New permission keys need a row in `public.permissions`
  BEFORE `role_permissions` (FK) — and mirror seeds in `supabase/seed.sql`.
  Test DDL against a shadow restore before the live DB (see
  `ATLAS_RESTORE_RUNBOOK.md`); note a schema-only shadow can't catch
  data-dependent seeds.
- **Background jobs: DB is the source of truth, BullMQ is just the kick.**
  Job tables carry status; workers poll + accept BullMQ; every worker has a
  `--once` mode used by smokes. Claims are atomic conditional updates
  (`update … where status='pending'`).
- **AI-native, not AI-assisted**: the assistant is a first-class interface to
  the whole platform (global "Ask ATLAS" launcher in `AppShell`). Every new
  module MUST ship with read tools in the catalogue and, for its write flows,
  proposable actions — a module the agent can't operate is incomplete.
  The model only reaches data through the fixed tool catalogue
  (`ai-tools.service.ts`), permission-checked per call, tenant from server
  context. Write operations only via propose→confirm→execute
  (`ai-actions.service.ts`); the confirm endpoint is never model-reachable.
  Never let AI compute financial figures — call the report RPCs.
  Provider: Moonshot `kimi-k2.6` via plain fetch (rejects non-default
  temperature — send none); `AI_DRIVER=mock` for deterministic tests.

## Verification (run before calling anything done)

```bash
pnpm turbo run lint typecheck test build          # must be green
set -a && source .env && set +a                   # root .env, gitignored
node apps/api/scripts/smoke-<module>.mjs          # E2E per module (API must run)
node apps/api/scripts/eval-ai.mjs                 # real-provider AI eval (security cats must be 100%)
```

24 smoke suites exist (`smoke-onboarding` … `smoke-payroll`; the 10 newest —
timetable, instalments, necta, hostel, transport, library, inventory, clinic,
platform-metrics, payroll — need the 0016–0028 batch applied first; so do
smoke-communication and smoke-ai-actions, which depend on 0026). They
create throwaway tenants against the live dev Supabase project and archive
them. `smoke-ai*` needs the API started with `AI_DRIVER=mock`. Onboarding is
rate-limited (6/min/IP) — space suites out or you'll hit 429s.

## Gotchas learned the hard way

- `class_sections.name` holds the stream label ("A"); there is NO `stream`
  column. Grade name comes from `grade_levels.name`.
- Supabase JS caps reads at 1000 rows — paginate with `.range()` for more.
- eslint's `no-unnecessary-type-assertion` fixer strips `as` casts on
  supabase results; type the destructure target instead.
- Tenants are never hard-deleted (audit_logs FK) — archive
  (`status='archived'`); the outbox join excludes suspended/archived/draft
  tenants (it drains configuration/data_review/training/live — fixed BUG-02:
  the old `'active'` literal was not a valid status and starved live tenants).
- `queue_announcement` takes `p_audience_type`, returns
  `{announcementId, recipients}`.
- Phone/admission numbers are strings (leading zeros); TZ phones normalise
  to `0XXXXXXXXX`.
- Next 16 uses `src/proxy.ts` (named `proxy` export), not `middleware.ts`;
  web env lives in `apps/web/.env.local`.
- macOS has no `timeout`; the dev DB direct host doesn't resolve — use the
  session pooler (`DATABASE_URL`); psql/pg_dump live under
  `/usr/local/opt/postgresql@17/bin`.
- New user-facing strings get EN + SW keys in `packages/i18n/src/index.ts`
  (shared by web AND mobile; `apps/web/src/i18n/index.ts` is only a
  re-export — don't add keys there). Keep both key sets exactly mirrored.
  Exception: students-import `TEMPLATE_HEADERS` stay English — they're the
  Excel re-import contract.
- Mobile/Metro on pnpm: hierarchical lookup must stay ENABLED in
  `apps/mobile/metro.config.js` (transitive deps like `@expo/metro-runtime`
  resolve by walking up from realpaths in `node_modules/.pnpm`;
  `disableHierarchicalLookup: true` breaks the bundle).
- Remote push does NOT work in Expo Go on Android (SDK 53+) — needs a
  development build; local notifications still work in Go. Push tokens also
  need `eas init` to have set `extra.eas.projectId` (until then
  `registerForPushNotifications` returns null by design).
- Uncommitted-file recovery: Turbopack sourcemaps under
  `apps/web/.next/server/chunks/ssr/*.js.map` carry full original TS in
  `sourcesContent` — recovered a destroyed working-tree file byte-perfect
  from there once. Check before resorting to `git restore`.
- Demo tenant "Chief Sarwatt School" has ALL assessments `published` (marks
  locked by design) and tenant status `configuration`; `school_owner` /
  `director` bypass permission checks (`SUPER_ROLES` in `tenant.guard.ts`).
- Payroll salary tables have NO member-read RLS on purpose — reads go through
  the API only (`payroll.view`). The AI payroll tool returns aggregates only.
- The scratch-Postgres shadow test needs `LC_ALL=en_US.UTF-8` for `pg_ctl`
  on this Mac ("postmaster became multithreaded" otherwise).
- Writes to the live dev DB (DDL or data) are blocked by the permission
  classifier — hand the human the exact command instead of retrying.

## House patterns (copy an existing file, don't invent)

- API endpoint: controller w/ `@UseGuards(AuthGuard, TenantGuard)` +
  `@RequirePermission('x.y')`, zod `safeParse` on every body, business errors
  as `{ code: 'STABLE_CODE' }` 400s (see `finance.controller.ts`).
- Web page: server `page.tsx` (auth + tenant redirect) + `"use client"` view
  using `apiFetch` (see `apps/web/src/app/staff/`).
- Mobile screen: expo-router route using the kit in
  `apps/mobile/src/components/` + `useT()` + `apiFetch`/RLS reads, tokens
  from `src/lib/theme.ts` (see `(tabs)/attendance.tsx`); the matching web
  view is the spec for queries/payloads/error codes.
- Smoke test: `apps/api/scripts/smoke-*.mjs` — plain node, creates users via
  service role, asserts status codes AND database state, archives the tenant.
- Migration: RLS enable + "members read" policy per tenant table; writes go
  through the API.
