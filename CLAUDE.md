# ATLAS — engineering conventions & handover

Tanzania-first multi-tenant school SaaS. pnpm + Turborepo monorepo:
`apps/web` (Next.js 16, App Router), `apps/api` (NestJS 11, port 4000),
`apps/workers` (BullMQ + standalone DB pollers), `apps/mobile` (Expo SDK 57 +
expo-router native iOS/Android app — see its README for dev/EAS),
`packages/i18n` (shared English string catalogue — web re-exports it),
`supabase/migrations`.
Operator/role docs: `docs/ADMIN_GUIDE.md`. Audit history/specs: `docs/audit/`.
Sales/GTM: `docs/sales/` (playbook + founding-schools offer).
Visual language: TWO systems, deliberately different in type, spacing and
surface, but ONE brand colour. The **product** uses `design.md` at repo root
(Inter + JetBrains Mono, pill buttons, 24px cards). The **marketing surface**
uses an Apple-derived system scoped under `.atlas-marketing` in
`apps/web/src/app/(marketing)/marketing.css` (alternating
light/parchment/near-black tiles, one shadow). Consult the right one before any
UI work; never hoist marketing tokens into `globals.css`.
**Atlas Blue is `#0052ff` on BOTH surfaces** (`--primary` in `globals.css`,
`--ap-primary` in `marketing.css`). Marketing used to carry its own `#0066cc`,
which read as a second brand colour on any page linking the two surfaces; the
owner's brand is white, blue and black, and it is one blue. Do not reintroduce
a second blue. Dark tiles use `--ap-primary-on-dark: #2997ff` (4.7:1 on
`--ap-tile-1`); plain `#0052ff` on a near-black tile is ~2.2:1 and unreadable.
Local preview: web on **3000** (it was free as of 2026-09-02; if something else
has claimed it, use 3001 or 3002). Whichever you choose, start the API with
`WEB_ORIGIN=http://localhost:<port>` or every client-side API call fails CORS
silently (see gotchas).

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

## HANDOVER (2026-09-15, `main` + marketing/login work now COMMITTED)

**Read this first, then the 2026-08-06 section below for platform and database
state, which is unchanged.**

**The 2026-09-02 marketing/login work is committed as of 2026-09-15**, together
with an SEO pass for the live domain. Gates re-run at that commit: lint 3/3,
typecheck 7/7, tests 4/4, build 3/3.

**The production domain is `atlasgo.co.tz`.** `NEXT_PUBLIC_ROOT_DOMAIN` must be
set to the bare apex in Vercel Production and left EMPTY everywhere else, or
previews redirect their own app routes at production. It is also what makes SEO
correct: metadataBase, every canonical, the sitemap and the og:image URLs are
all derived from it, and unset they fall back to localhost. A production build
with it set was verified to emit `https://atlasgo.co.tz` canonicals and og:image
URLs. See `apps/web/.env.production.example`.

**The NestJS API is not hosted anywhere.** `NEXT_PUBLIC_API_URL` still points at
`http://localhost:4000`, so on a web-only deployment the dashboard renders and
then fetches nothing, and `/anza` leads fall through to the email path in
`app/api/public/prospect/route.ts` without reaching `prospect_submissions`. That
fallback only actually reaches a human if `RESEND_API_KEY`, `LEAD_EMAIL_TO` and
`LEAD_EMAIL_FROM` are set; otherwise the driver resolves to console and the lead
is lost. Set them before pointing any real traffic at `/anza`.

Gates after the work: lint 3/3, typecheck 7/7, tests 4/4, build 3/3. Every
marketing route re-checked at 200 (`/`, `/tour`, `/anza`, `/blog`, `/terms`,
`/privacy`, `/login`).

**What was done: a design and copy pass on the public surfaces.**

- **No em dashes in user-facing copy.** Every one was rewritten into a comma,
  colon or full stop across the landing page, nav, footer, tour, `/anza`
  funnel, blog articles, terms, privacy and login. Owner's instruction: the
  copy should not read as AI-generated. Code comments still use them, which is
  the existing house style. **Keep new user-facing strings free of them.**
- **Broken navigation fixed.** "What it does" pointed at `#modules`, which
  existed nowhere; every section link was a bare hash, so from `/blog` they
  resolved to `/blog#pricing`. All are absolute now (`/#pricing`) and the
  landing page carries `id="modules"`. If you add a section link, make it
  absolute or it breaks on every page except the landing page.
- **Three "Screenshot pending" grey boxes were shipping live.** `AppWindow`
  now returns `null` when it has no `src` in production, so the placeholder is
  a development-only note to ourselves. Two tour stops (the invoice and the
  report card) still have no capture and render text-only in production.
  Needed: `/finance/[id]` with payments recorded, and a published report card.
- **Three panels are drawn, not captured**
  (`app/(marketing)/_components/panels.tsx`): the fee-reminder and absence SMS
  on a phone, the attendance register on a phone, and the assistant as a
  conversation with source chips. A teacher marks a register on a phone and a
  parent only ever meets ATLAS as a text message, so a desktop screenshot
  would misrepresent both. Used by the role switcher and the tour. Each says
  it is an example in its caption.
- **Still no testimonials, and do not invent any.** `pillars.ts` explains why.
  The owner asked for school testimonials and was told no; the login showcase
  carries real product screenshots instead.
- **Login rebuilt** (`app/login/`): split screen, form left, auto-advancing
  screenshot carousel right, no social buttons (owner's choice). White and
  **light-locked** via `.atlas-light-lock` in `globals.css`, so it ignores the
  dark-mode toggle by owner request. Remove that one class from
  `login/page.tsx` to hand the page back to the theme.
- **`ContourField`** (`components/contour-field.tsx`) is the topographic line
  pattern. It holds no tokens and takes its colours as props, so it belongs to
  neither design system. It is on the login **form side only**: behind the
  screenshots it competed with them, and the owner explicitly rejected it in
  the landing hero. **Do not put it back in the hero.**
- **Brand assets added**: `app/favicon.ico` (was still the default Next.js
  triangle), `app/icon.svg`, `app/apple-icon.png`, and a 1200x630
  `opengraph-image.png` / `twitter-image.png` under `(marketing)/`. They live
  in the marketing segment because a child `openGraph` object replaces the
  parent's, so a root-segment OG image never attached. Generated with `sharp`
  from `node_modules/.pnpm`; no generator script is committed because sharp is
  only a transitive dependency.
- **Meta**: title is `School management software for Tanzanian schools`, with
  the brand appended by the root template. Do NOT put "ATLAS" in the marketing
  layout's `title.default` again; it rendered the brand twice. The description
  is templated off `lib/offer.ts` so the SMS figure cannot drift, and the price
  is deliberately absent from it.
- **Accessibility fixes**: `--ap-ink-48` darkened to `#6e6e73` (was 4.35:1 on
  parchment), the ghost button on dark tiles is now white-on-outline (was
  2.2:1), the nav frost went 82% to 92% because display type read through it,
  and the role tablist answers arrow keys.
- **Mobile**: the marketing nav had `display: none` on every link below 834px,
  leaving a logo and one button. There is a sheet now (`nav.tsx`, client
  component). The pricing figure was a fixed 56px monospace and overflowed a
  375px screen; it is `clamp()` now.
- **Shared i18n changed**: `login.demoDivider`, `login.tryDemo` and
  `login.demoHint` in `packages/i18n`. `apps/mobile` renders all three, and
  its login screen has the same divider/button/hint structure, so the new copy
  reads correctly there too. It was not visually re-checked on device.

**Known gaps, not started:**

- **No password reset flow anywhere.** The redesigned login deliberately has no
  "Forgot password?" link rather than one that goes nowhere.
- **`proxy.ts` calls Supabase on `/login`.** Marketing paths return early on
  purpose so the funnel survives a sleeping database; `/login` does not, so
  when the database is unreachable the sign-in page takes ~26s and its own
  assets starve behind it. Worth the same early return, but it is auth code and
  was not touched without a live database to test against.
- **The dev Supabase host resolves again.** `zwbsyiwtrabpysylyaaj.supabase.co`
  was NXDOMAIN on 2026-09-02 but answered on 2026-09-15. Sign-in, the smoke
  suites and the AI eval have still NOT been re-run against it, so nothing
  auth-related is verified, only reachable.
- Mobile viewports were verified with a throwaway iframe harness on a second
  port, because `resize_window` does not work against a maximised Chrome
  window. Useful trick; nothing about it is committed.

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

- **No em dashes in user-facing copy** (owner decision, 2026-09-02: it reads
  as AI-generated). Rewrite into a comma, a colon or a full stop; never swap in
  a hyphen. Applies to every visible string on the marketing surface, in the
  product and in `packages/i18n`. Code comments are exempt.
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
- **A bare hash link works only on the landing page.** `<Link href="#pricing">`
  in the shared nav or footer resolves to `/blog#pricing` on the blog and goes
  nowhere. Section links must be absolute: `/#pricing`.
- **Metadata merges shallowly: a child's `openGraph` REPLACES the parent's.**
  A file-based `opengraph-image.png` attaches to the segment it sits in, so a
  root-level one silently vanishes from any route that declares its own
  `openGraph`. Keep the image file in the same segment as the metadata object.
- **A child's `title.default` still gets the parent's `title.template`
  applied.** Naming the brand in both renders it twice (`... | ATLAS · ATLAS`).
  Only one of the two should carry it.
- Metadata icon routes are served at `/icon.svg`, `/favicon.ico`,
  `/apple-icon.png` and `/opengraph-image*.png`, all of which the `proxy.ts`
  matcher already excludes by extension. A code-generated `icon.tsx` would be
  served at `/icon` instead, which the matcher does NOT exclude, so it would
  hit the proxy and 307 or 401. Prefer static icon files.
- `AppWindow` renders its "Screenshot pending" placeholder in development only
  and returns `null` in production. A slot with no capture collapses on the
  live site rather than shipping a grey box to a head teacher.

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
