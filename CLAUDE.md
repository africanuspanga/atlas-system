# ATLAS — engineering conventions & handover

Tanzania-first multi-tenant school SaaS. pnpm + Turborepo monorepo:
`apps/web` (Next.js 16, App Router), `apps/api` (NestJS 11, port 4000),
`apps/workers` (BullMQ + standalone DB pollers), `apps/mobile` (Expo SDK 57 +
expo-router native iOS/Android app — see its README for dev/EAS),
`packages/i18n` (shared English string catalogue — web re-exports it),
`supabase/migrations`.
Operator/role docs: `docs/ADMIN_GUIDE.md`. Audit history/specs: `docs/audit/`.
Sales/GTM: `docs/sales/` (playbook + founding-schools offer).
Visual language: TWO systems, deliberately different, do not merge them.
The **product** uses `design.md` at repo root (Atlas Blue #0052ff, Inter +
JetBrains Mono, pill buttons, 24px cards). The **marketing surface** uses an
Apple-derived system scoped under `.atlas-marketing` in
`apps/web/src/app/(marketing)/marketing.css` (#0066cc, alternating
light/parchment/near-black tiles, one shadow). Consult the right one before any
UI work; never hoist marketing tokens into `globals.css`.
Local preview: web on **3001 or 3002** — 3000 is taken by another process.
Whichever you choose, start the API with `WEB_ORIGIN=http://localhost:<port>`
or every client-side API call fails CORS silently (see gotchas).

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
deny-all RLS, API-only via POST/DELETE /devices) · 0029 permission-aware RLS
(`app.has_permission`, tenant-status gating, parent-membership backfill,
platform_role trigger) · 0030 student & academic lifecycle
(set_student_status, set_class_enrolment, create_academic_year +
activate/grade-level/section writers) · 0031 go-live hardening (Tanzania dates,
payment idempotency/date rules, debtors cutoffs, SMS claims/caps, verified
payroll + employer journals, A-Level aggregate) · 0032 payroll-settings seed ·
0033 operational platform-overview scoping · 0034 prospect_submissions
(marketing funnel leads, deny-all RLS, API-only) · 0035 SMS allowance becomes
annual + purchasable (`plans.limits.smsIncludedYear`, `tenant_sms_balance`,
`app.tenant_sms_usage`; `claim_notification` spends included then purchased)
· 0036 lets the service role read `public.tenant_sms_usage`.

## HANDOVER (2026-08-06, `main` == `audit/production-readiness` @ `56d3585`)

**Current state:** `docs/audit/HANDOVER_2026-08-06.md`.
**Whether to ship:** `docs/audit/GO_LIVE_READINESS_2026-08-03.md` — its
blockers still stand; only its state facts are superseded.

- The linked Supabase project is at migration **`0036`**. Shadow replay:
  73 tables, 61 policies, 219 functions. `prospect_submissions` is the only
  RLS-enabled table with zero policies — intentional, API-only by design.
- **ATLAS is English-only** (owner decision). No Swahili dictionary, no `Lang`
  type, no switcher, and the guardian SMS templates are English.
- A **marketing surface** exists: landing page, blog, `/anza` funnel, no-login
  tour, draft terms/privacy. The **dashboard moved off `/` to `/dashboard`**;
  the apex serves marketing and `app.` serves the product via `lib/hosts.ts`.
- Gates at this commit: lint 3/3, typecheck 7/7, tests 4/4, builds 3/3.
- **NOT re-run since 3 August — do not assume they hold at `0036`:** the 25
  smoke suites (start with `smoke-communication`; 0035 changed
  `app.claim_notification`), `eval-ai.mjs`, and the dependency audit.
- `/terms` and `/privacy` carry a "Draft — not yet in force" banner and unfilled
  placeholders. **The banner stays until Tanzanian counsel signs off.**

Never run the old numeric-range psql loop below. For another environment:

```bash
./scripts/shadow-migrations.sh
set -a && source .env && set +a
pnpm exec supabase db push --dry-run --include-all
pnpm exec supabase db push --include-all
```

Open paid onboarding is a **no-go** until production web/API/queue worker/
outbox drainer, HTTPS/Redis/Sentry/health/Beem/EAS, current full restore,
PDPC/DPA/cross-border AI, school payroll verification, and supervised
`training` acceptance are complete. Product backlog: payment webhooks,
push sending, support impersonation, document RAG, student portal, marketing/
self-service signup, AI retention/latency/cost work, and broader automated load/
browser coverage.

## HISTORICAL HANDOVER (2026-07-31 — superseded; do not execute its gate)

<details>
<summary>Preserved July handover evidence</summary>

**Full detail: `docs/audit/HANDOVER_2026-07-31.md`. Findings register (103
confirmed): `docs/audit/ATLAS_CODE_REVIEW_2026-07.md`.**

**Where things stand.** A full adversarial code review (171 agents, 123
candidates, 26 refuted) produced 103 confirmed findings in six themes. Themes
1-4 are fixed and committed as waves 0-3; themes 5-6 are NOT started.

| Commit | Wave |
|---|---|
| `36c4a09` | Sprint snapshot — 11.5k insertions incl. all of apps/mobile + migrations 0016-0028 |
| `2f4c2ef` | 1 — security: migration 0029 permission-aware RLS |
| `477a888` | 2 — data destruction: import duplication, xlsx bomb, 1000-row truncation |
| `85f9b74` | 3 — lifecycle: migration 0030 + student/academic write paths |
| `c74e027` | 3 — surface: smoke-lifecycle, AI propose-actions, web UI |

Gate at `c74e027`: `pnpm turbo run lint typecheck test build --force` ->
14/14, 0 cached. Working tree clean.

**THE GATE — migrations 0016-0030 are still NOT applied to the live dev
Supabase project.** Until they are, two P0s are live: platform_role
self-escalation (0026), and every parent reading their entire school —
roster, DOBs, all guardian contacts, the full fee ledger, marks, SMS outbox
(0029 SEC-029-B; 0026 stops minting those memberships but never removed the
existing ones). Agents are blocked from DDL by the permission classifier.
Rehearse with `./scripts/shadow-migrations.sh`, then a human runs — note
`{16..30}` AND `--single-transaction`:

```
set -a && source .env && set +a && \
for f in supabase/migrations/000000000000{16..30}_*.sql; do
  /usr/local/opt/postgresql@17/bin/psql "$DATABASE_URL" \
    --single-transaction -v ON_ERROR_STOP=1 -f "$f" || break
done
```

`--single-transaction` is mandatory: psql autocommits per statement and
0016-0028 carry no transaction of their own, so a migration failing between
`drop policy` and `create policy` leaves that table RLS-enabled with ZERO
policies (deny-all — presents to a school as "our data disappeared"). That
happened to `student_guardians` on the shadow cluster. 0029/0030 wrap
themselves; the earlier ones do not.

**Post-apply checklist, in order:**
1. Record 0029's notice `0029: retired N permission-less parent/student
   membership(s)` — N is how many parents had full read of their school.
2. API with `AI_DRIVER=mock`: run the ten newest module smokes, plus
   `smoke-communication` + `smoke-ai-actions` (fail pre-0026) and the new
   `smoke-lifecycle` (needs 0030). Space them out — 6/min/IP onboarding cap,
   and smoke-lifecycle onboards two tenants by itself.
3. Restart with the real provider, run `eval-ai.mjs` (security cats 100%).
4. Spot-check wave 1 did not over-restrict: a **bursar** must still see
   `/finance`; a **teacher** must now see nothing there. That is the intended
   change and the one most likely to be reported as a regression.
5. Mobile one-timers (human, interactive): `npx eas-cli login && eas init`
   in `apps/mobile`, then `eas build`/`eas submit` per its README.

**Next up — wave 4 (money & time), then wave 5 (hardening).** Highest value
first: 63 `toISOString()` sites of which exactly ONE handles UTC+3 (plus
`current_date` column defaults, which are UTC on Supabase) · payments have no
idempotency key · payroll statutory-rates dialog crashes on open (camelCase
vs snake_case) and rates labelled "%" are stored as fractions, unbounded ·
A-Level division never computed · `smoke-payroll` asserts the OLD over-taxing
PAYE numbers. Then wave 5: `smsMonthly` unenforced · SMS driver silently
falls back to console while `drain-outbox` marks rows sent (you can ship
believing SMS works when nothing sent) · outbox retries die permanently after
~30 min with no requeue · eight pages spin forever on a dropped connection ·
mobile sessions in plaintext AsyncStorage · one test file in 51.5k LOC, no CI.

**Older backlog (unchanged):** renewal-reminder outbox job · failed-SMS
drill-down · AI error/latency columns + 90-day `ai_messages` purge worker ·
ARR/churn/LTV snapshot · support impersonation
(`docs/audit/ATLAS_OWNER_DASHBOARD_AUDIT.md`) · payment gateway webhooks
(`docs/product/PAYMENTS_INTEGRATION_PLAN.md`) · student portal · marketing
site. GTM/sales material lives in `docs/sales/`.

</details>

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
  (currently 0001–0033; one sanctioned exception: 0025 widened
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
pnpm --filter @atlas/web exec next typegen         # keep sequential with build
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm audit --audit-level moderate
set -a && source .env && set +a                   # root .env, gitignored
node apps/api/scripts/smoke-<module>.mjs          # E2E per module (API must run)
node apps/api/scripts/eval-ai.mjs                 # real-provider AI eval (security cats must be 100%)
```

25 smoke suites exist and all require the migration-0033 contract. They create
throwaway tenants/users, so run them in staging or during an explicitly approved
readiness exercise and archive leftovers. `smoke-ai*` needs the API started with
`AI_DRIVER=mock`; `smoke-platform` must run after restart with the normal
onboarding limit because it asserts 429. Follow `docs/ATLAS_TESTING_GUIDE.md`.

## Gotchas learned the hard way

- `class_sections.name` holds the stream label ("A"); there is NO `stream`
  column. Grade name comes from `grade_levels.name`.
- **Rehearse every migration** with `./scripts/shadow-migrations.sh` (throwaway
  local PG 17 cluster, whole chain + seed, then lists any table left
  RLS-enabled with zero policies). It has already caught three real defects.
- **Migrations must be atomic.** New files wrap themselves in `begin`/`commit`.
  Legacy files 0016–0028 do not; if replaying them manually in an isolated
  scratch environment, use one transaction per file. For linked Supabase
  environments, use the rehearsed `supabase db push` workflow above—never the
  historical numeric-range loop.
- **`create index if not exists` matches on NAME, not columns** — a
  differently-named index over identical columns is NOT suppressed and just
  doubles write cost.
- **A `SECURITY DEFINER` trigger sees `current_user` as the function owner**,
  not the caller, so a role check inside one never matches an end-user role.
  Use SECURITY INVOKER when the point is to identify the caller.
- **Testing RLS as `postgres` proves nothing** — superusers bypass RLS. Use
  `begin; set local request.jwt.claim.sub='<uuid>'; set local role
  authenticated; …`; `SET LOCAL` outside a transaction is a silent no-op, which
  makes a broken test look like it passed.
- **`.limit(N)` for N > 1000 does nothing** — PostgREST truncates at 1000
  silently. Paginate with `.range()` and a deterministic `.order()`
  (`readAllPages` in `imports.controller.ts` is the reference).
- Business errors must be `{ code: 'STABLE_CODE' }`, never a bare string —
  both error maps key off `code`, so a message-only exception bypasses the
  string catalogue and ships unreviewed copy to users.
- Adding an AI action is not enough: `SYSTEM_PROMPT` rule 9 in `ai.controller.ts`
  enumerates what the model may never do, and a stale entry there makes it
  refuse a capability it now has.
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
- **The apex is marketing, `app.` is the product.** `lib/hosts.ts` is the only
  source of truth for the split; `proxy.ts` runs the host decision BEFORE any
  auth or database work, and marketing/shared paths return before the Supabase
  call so the funnel survives a sleeping database. Redirects are 307, never
  308. Cross-host links must be plain `<a>` built with `appHref()`/
  `marketingHref()` — a `<Link>` to the other surface is 307'd straight back.
  `NEXT_PUBLIC_ROOT_DOMAIN` is production-only; empty means combined mode.
- **A new public marketing route must be added to `MARKETING_ONLY_PATHS` in
  `lib/hosts.ts`**, or it 401s for the anonymous visitors it exists to serve.
  This is the single most likely thing to break.
- **The price lives only in `apps/web/src/lib/offer.ts`.** The visible page AND
  the JSON-LD Offer render from it, so structured data can never advertise a
  retired price. Never write the price as a literal anywhere else.
- **JSX strips leading whitespace from a text chunk containing a newline**, so
  `</strong> word` wrapping to the next line renders as `wordword`. Use
  `{" "}`. Check the RENDERED html, not the source.
- **Client-side API calls need `WEB_ORIGIN` to match the web port.**
  `resolveWebOrigin()` (apps/api/src/config.ts) defaults to
  `http://localhost:3000`, so running web on 3001/3002 fails the CORS
  allowlist. The preflight still answers 204 but without a matching
  `Access-Control-Allow-Origin`, so the browser never sends the real request —
  the API logs NOTHING and the page just sits on "Loading…". Server components
  keep working, which makes it look like only some pages are broken. Start the
  API with `WEB_ORIGIN=http://localhost:<web port>`.
- macOS has no `timeout`; the dev DB direct host doesn't resolve — use the
  session pooler (`DATABASE_URL`); psql/pg_dump live under
  `/usr/local/opt/postgresql@17/bin`.
- **ATLAS is English-only.** There is one dictionary, no `Lang` type, no
  language cookie and no switcher. New user-facing strings get an English key
  in `packages/i18n/src/index.ts` (shared by web AND mobile;
  `apps/web/src/i18n/index.ts` is only a re-export — don't add keys there).
  Deliberately kept despite the English-only rule, because they are data or
  input tolerance rather than UI language: the `subjects.name_sw` /
  `assessments.name_sw` columns, "Kiswahili" as a taught subject in
  `subjects.presets.ts` and the HKL combination, and the Swahili spreadsheet
  header aliases in `imports/import-domains.ts` (schools' existing Excel files
  really do have `jina la mwanafunzi` headers — removing these breaks import).
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
- Live database changes require an approved change window, a shadow/data
  rehearsal, Supabase CLI dry run, backup/restore evidence, and verification;
  never bypass migration history with ad-hoc DDL.

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
