# ATLAS Administrator & User Guide

_Updated 2026-07-17. Audience: everyone who operates or uses ATLAS — the
platform (SaaS) staff, school owners and administrators, teachers, finance
staff, and parents. For engineering conventions see the root `CLAUDE.md`;
for the visual language see `design.md`; for audit history see `docs/audit/`._

> **Deployment note:** migrations 0016–0028 (timetable, instalments,
> NECTA pack, hostel, transport, library, inventory, clinic, platform
> metrics, payroll, production hardening, security polish, mobile device
> tokens) must be applied to the database before the sections marked
> **[0016+]** work. Apply them with the handover command in `CLAUDE.md` →
> Handover state.

---

## Part 0 — From zero to a running school: the complete walkthrough

The end-to-end path a school owner or administrator follows, from nothing
to daily operation. Each step links to the detailed section.

1. **Create the school** — register and complete `/onboarding` yourself, or
   have ATLAS staff walk you through it. A 30-day trial subscription starts
   automatically (Part III §1).
2. **Finish the 3-step onboarding wizard** — school details → academic year
   with Muhula terms (Muhula wa Kwanza / wa Pili, January–December default)
   → classes from the Tanzanian presets (Chekechea, Std I–VII, Form 1–6).
   The setup is atomic: it all lands, or none of it does (Part III §2).
3. **Configure academics** — review years, terms, classes and streams at
   `/academics`; load subjects from the Tanzanian curriculum presets
   (Subjects dialog on `/assessments`, per education level) — NECTA grading
   bands apply automatically; A-Level: load standard combinations at
   `/academics` **[0018+]**. Create the period grid at `/timetable`
   ("Create default periods") **[0016+]** (Part III §3).
4. **Invite staff** (`/staff`) — by email, each with a role (Part II is the
   who-can-do-what matrix). Invite links are single-use and expire.
5. **Import students** — the `/imports` wizard or the Excel dialog on
   `/students`; the template carries guardian phone/email columns so parents
   arrive linked. Upload → map → dry run → approve. Mid-year switchers:
   import opening balances too — posted as invoices + journal entries,
   never raw edits (Part III §2).
6. **Set up fees** (`/finance`) — define fee items for the year, issue
   invoices per student; optionally split an invoice into up to 6
   instalments **[0017+]** (Part III §5).
7. **Run the daily rhythm** — teachers mark attendance (absent students'
   guardians get a Kiswahili SMS automatically) and enter marks; finance
   receives payments and prints receipts (Part III §4–5).
8. **Close the term** — publish results (locks marks), print report cards,
   pull the NECTA CA summary and candidates export **[0018+]**, then chase
   debtors at `/finance/debtors` and send fee reminder SMS **[0017+]**
   (Part III §3, §5).
9. **Bring parents in** — "Invite parent" on the student record (needs an
   email on the guardian); parents get `/portal` with attendance, fees and
   published report cards for their children only (Part III §7).
10. **Ask ATLAS, always** — the floating button on every page answers
    questions across every module and can *propose* actions (admit a
    student, record a payment…) that execute only after you confirm
    (Part IV).

---

## Part I — The platform at a glance

| Surface | URL path | Who |
|---|---|---|
| School dashboard | `/` | School staff, by role |
| Admissions overview | `/admissions` | Staff with `students.view` |
| Students | `/students` (+ report cards) | Staff with `students.*` |
| Academics (subjects, classes, combinations, CA, NECTA export) | `/academics` | Staff |
| Timetable **[0016+]** | `/timetable` | All staff (edit: `timetable.manage`) |
| Attendance | `/attendance` | Teachers and above |
| Assessments & marks | `/assessments` | Teachers and above |
| Finance (fees, invoices, payments) | `/finance` | Finance roles |
| Debtors (wadaiwa) **[0017+]** | `/finance/debtors` | Finance + leadership |
| Accounting (trial balance, journal) | `/accounting` | Finance roles |
| Payroll **[0025+]** | `/payroll` | Bursar, school admin |
| Parents directory | `/parents` | Staff with `guardians.view` |
| Communication (SMS announcements) | `/communication` | `communication.send` |
| Hostel **[0019+]** | `/hostel` | Staff (manage: leadership) |
| Transport **[0020+]** | `/transport` | Staff (manage: leadership) |
| Library **[0021+]** | `/library` | Staff (manage: leadership) |
| Inventory **[0022+]** | `/inventory` | Leadership + finance |
| Clinic **[0023+]** | `/clinic` | Teachers and above |
| Data import wizard | `/imports` | `imports.manage` |
| Reports (PDF/XLSX/CSV) | `/reports` | `reports.generate` |
| Settings (school profile, language) | `/settings` | Any member |
| AI assistant | `/assistant` + the floating **Ask ATLAS** button on every page | Any active member (permission-scoped) |
| Parent portal | `/portal` | Guardians (non-member accounts) |
| ATLAS control centre + super dashboard | `/platform` | Platform staff only |

Services: Next.js web app, NestJS API (port 4000), background workers
(BullMQ + DB pollers), Supabase (Postgres + Auth + Storage), Redis — plus
a native **mobile app** (below).

### The ATLAS mobile app (iOS & Android)

`apps/mobile` is a native app (Expo), not a wrapped website, sharing the
same accounts, permissions and Swahili/English dictionary as the web. Staff
sign in with their normal credentials and get the daily-rhythm surfaces:
dashboard numbers, student lookup (search works with leading-zero admission
numbers), attendance marking with one-tap toggles, invoices + receipt
recording, and the full **Ask ATLAS** assistant including confirm/reject
cards for proposed actions. A signed-in **guardian** (no staff role) lands
in a native parent portal — children, balances, attendance. Account
creation and school onboarding stay on the web; the app is for people
already invited.

How schools get it today: during the pilot phase, via the **Expo Go** app
(App Store / Play Store) pointed at our published build or a QR from the
dev server; after store submission (see the runbook), directly from the
App Store / Play Store. Push notifications require the store/development
build — inside Expo Go on Android they are silently unavailable (platform
limitation), and the app copes without them.
The UI is fully bilingual — English and Kiswahili — switched from the header
or `/settings`; the choice is remembered per browser. The sidebar and
breadcrumbs track the route you're on, and the big directories (students,
parents, admissions) have search and pagination, so schools of any size stay
fast. Errors appear as plain English/Kiswahili sentences; where no friendlier
message exists, the stable error code is shown in parentheses — quote it when
reporting a problem.

---

## Part II — Roles: who can do what

Roles are assigned when staff are invited (`/staff`). `school_owner` and
`director` are **superusers within their school** — every permission check
passes. Parents are *not* members; they only reach `/portal`.

| Capability | Owner/Director | School Admin | Head Teacher | Academic Master | Teacher | Class Teacher | Bursar | Accountant | Cashier | Parent |
|---|---|---|---|---|---|---|---|---|---|---|
| Students: view / create / archive | ✓ | ✓ | ✓ | view | view | view | view | view | view | own children |
| Attendance: mark / correct / approve | ✓ | view | ✓ | view | mark | mark+correct | — | — | — | view own |
| Marks: enter / moderate / publish | ✓ | — | ✓ | ✓ | enter | enter | — | — | — | results only |
| Timetable: view / manage | ✓ | ✓ | ✓ | ✓ | view | view | — | — | — | — |
| Combinations (A-Level): manage | ✓ | ✓ | ✓ | ✓ | — | — | — | — | — | — |
| Invoices: create / view | ✓ | — | — | — | — | — | ✓ | ✓ | view | own |
| Payments: receive / reverse | ✓ | — | — | — | — | — | receive+reverse | receive | receive | — |
| Debtors report | ✓ | ✓ | ✓ | — | — | — | ✓ | ✓ | — | — |
| Payroll: view / manage | ✓ | ✓ | — | — | — | — | ✓ | view | — | — |
| Hostel/Transport/Library: manage | ✓ | ✓ | ✓ | view | view | view | — | — | — | — |
| Inventory: view / manage | ✓ | ✓ | view | — | — | — | ✓ | view | — | — |
| Clinic: record / view | ✓ | ✓ | ✓ | — | view | view | — | — | — | SMS only |
| Announcements / fee reminders | ✓ | ✓ | ✓ | — | — | — | reminders | — | — | receives |
| Staff: invite | ✓ | ✓ | ✓ | — | — | — | — | — | — | — |
| Imports / Reports | ✓ | ✓ | ✓ | reports | — | — | ✓ | ✓ | — | — |

(The definitive matrix is `supabase/seed.sql` → `role_permissions`.)

---

## Part III — Guide per role

### 1. Platform staff (the SaaS owner) — `/platform`

Platform staff are ordinary auth users with `profiles.platform_role` set
(`super_admin` acts; `support`/`finance`/`implementation`/`auditor` read).
Grant via SQL only — never through the app:

```sql
update public.profiles set platform_role = 'super_admin' where id = '<user uuid>';
```

**Super dashboard [0024+]** (top of `/platform`):
- **Revenue** — MRR in TZS, MRR by plan, paying tenants, subscription status
  breakdown, trials expiring within 14 days (call these schools!).
- **Pipeline** — tenants by lifecycle status: `draft → configuration →
  data_review → training → live` (suspended/archived aside). A school stuck
  in `configuration` (like the demo) hasn't been graduated to `live` yet.
- **Health** — every school with students/staff counts, 7-day activity
  (registers, marks, payments, AI use), last-active date and a bucket:
  **active** (≤3 days), **quiet** (4–14), **silent** (>14 or never). Silent
  schools are listed first — that's your churn-risk call list.
- **Unit costs** — per school for any date range: SMS queued, AI requests,
  AI tokens, against their plan price. Watch for schools whose usage costs
  exceed their subscription.

**Tenant actions** (below the dashboard; all `super_admin`-only):
- **Suspend** — written reason required; all API access stops instantly.
- **Reactivate** — choose which lifecycle stage to restore
  (`draft`/`configuration`/`data_review`/`training`/`live`): a school
  suspended mid-onboarding goes back to where it was, not blindly to live.
- **Change plan** — pick the plan **and a billing cycle** (monthly/annual).
  The current subscription row is closed and a **new dated one** starts
  today, so billing history is preserved; caps apply immediately and the
  paid-until date shows in the tenant table.
- **Record payment** — this is how ATLAS revenue is collected today:
  manual reconciliation of a bank/M-Pesa transfer (no payment gateway yet).
  Enter months paid (1–24), the transfer reference and a reason; paid-until
  extends from *max(today, current period end)* — paying early never loses
  days — and a `past_due` subscription recovers to `active`.
- **Extend trial** — 1–180 days, added from max(today, current trial end).
- **Archive** — the end of the lifecycle (data is retained; tenants are
  never deleted). Written reason required, and archiving a **live** school
  demands an explicit "archive it anyway" confirmation so a typo can't take
  a paying customer offline.

Every action lands in `platform_audit_logs` **and** the tenant's own audit
log. The **Platform audit trail** panel at the bottom of `/platform` shows
who did what, when and why (filterable by tenant ID) — readable by *every*
platform role, so support and auditors can see actions they cannot take.

**Subscriptions:** onboarding auto-creates a 30-day trial. Enforcement is in
the API guard on every request — suspended → everything blocked; expired
trial/cancelled → writes blocked, reads open; a **lapsed paid subscription**
(`past_due`, or `active` with paid-until in the past) gets the same
read-only posture — writes rejected with `SUBSCRIPTION_LAPSED` — until a
payment is recorded. A school is never locked away from its own data, and a
null paid-until means "no end" (legacy rows never lock out). Plan caps
(students, staff seats) are enforced at creation and import approval, not
by hiding menus. Each plan also carries a monthly AI token allowance — see
Part IV.

### 2. School owner / school administrator

You see everything in your school. Your daily loop:

1. **Dashboard** (`/`): enrolment, attendance today, collections, outstanding.
2. **Admissions** (`/admissions`): total enrolment, by-grade breakdown,
   recent admissions. Add students at `/students` (one by one or Excel
   import at `/imports`).
3. **Money**: `/finance/debtors` is your chase list — per class, with
   guardian phone numbers and overdue amounts; press **Send fee reminders**
   to queue Kiswahili SMS to every debtor's primary guardian (deduped —
   parents are never spammed twice for the same invoice).
4. **Staff** (`/staff`): invite by email with a role; the invite link expires
   and is single-use. Set salaries and run monthly payroll at `/payroll`.
5. **Oversight**: `/reports` for signed-off PDF/XLSX reports;
   `/settings` for the school profile and language; audit trail is automatic.

**Onboarding a new school** (operator or owner):
1. Register and complete `/onboarding` — atomic: tenant, campus, academic
   year, terms, classes (Tanzanian presets: Chekechea, Std I–VII, Form 1–6).
2. Import data at `/imports` (CSV/XLSX, English or Swahili headers):
   upload → map columns → **dry run** → review errors → approve.
   Domains: students+guardians, opening balances (posted as invoices +
   journal entries — never raw edits).
3. Follow `docs/audit/ATLAS_PILOT_RUNBOOK.md`: rehearse, get the school's
   **written sign-off on totals**, then cut over.

### 3. Head teacher / academic master

- **Timetable [0016+]** (`/timetable`): create the period grid once
  ("Create default periods"), then click any cell to set subject + teacher.
  ATLAS blocks a teacher being in two classes at the same time
  (TIMETABLE_TEACHER_CLASH). Teachers see their own load via "My timetable".
- **Assessments** (`/assessments`): create assessments (test/mid-term/
  terminal/mock) per class+term with weights; teachers enter marks;
  **you publish** (`results.publish`) — publishing locks marks and makes
  results count on report cards. Corrections after publishing = new
  assessment (results are never silently edited).
- **Academics** (`/academics`): subjects (Tanzanian curriculum presets),
  classes, grade levels, terms. **[0018+]** A-Level: load standard
  combinations (PCM, PCB, CBG, EGM, HGE, HGL), assign each Form 5–6 student
  a combination, view cumulative **CA summary** per class/year (weighted
  across all published assessments in all terms), and download the **NECTA
  candidates CSV** (surname-first uppercase, M/F, DD/MM/YYYY, combination).
- **Attendance approvals**, staff invitations, announcements — all yours.

### 4. Teacher / class teacher

- **Attendance** (`/attendance`): pick class + date, mark
  present/absent/late/excused ("Mark all present" then adjust), save.
  Absent students' primary guardians get a Kiswahili SMS automatically.
  Re-saving a submitted register records a *correction* (class teachers
  can; subject teachers can't).
- **Marks** (`/assessments` → assessment → subject): enter 0–100 per
  student; grades compute automatically (NECTA bands). If the assessment is
  already published you'll see "results published — marks are locked".
- **Timetable [0016+]**: "My timetable" shows your week.
- **Clinic [0023+]** (view), **Library [0021+]** (view): look up visits and
  who holds which book.
- **Ask ATLAS** (floating button, every page): "Nani hawakuhudhuria leo?",
  "class average for Form 2A mid-term?" — the AI answers only what your role
  may see.

### 5. Bursar / accountant / cashier

- **Fee items & invoices** (`/finance`): define fee items per year, issue
  invoices per student. Numbers are sequential (INV-xxxxx / RCT-xxxxx).
- **Instalments [0017+]** (invoice detail): set up to 6 instalments that
  must sum exactly to the invoice total, with ascending due dates. Payments
  fill instalments oldest-first; each shows paid/due/overdue/upcoming.
- **Receive payments**: cash, M-Pesa, Tigo Pesa, Airtel Money, HaloPesa,
  bank, cheque. Every payment posts a balanced journal entry automatically.
  **Mistakes are reversed, never edited** (bursar-only) — the database
  physically refuses edits, even for developers.
- **Debtors [0017+]** (`/finance/debtors`): as-of date, per-class balances
  and overdue amounts (reconciled to the ledger to the shilling), fee
  reminder SMS button.
- **Accounting** (`/accounting`): trial balance + journal — always balanced
  by construction. The trial balance is served by the API from the same
  ledger-reconciled report SQL as printed reports, so screen, PDF and AI
  answers all match. Reports that don't reconcile **refuse to generate**
  (`REPORT_RECONCILE_FAILED`) — treat as P0.
- **Payroll [0025+]** (`/payroll`): set staff salaries (basic, allowances,
  HESLB flag). Run a month → draft with PAYE (progressive bands), NSSF
  (10%), HESLB (15% where flagged), net pay. **Post to ledger** books one
  balanced journal (Salaries expense / Payroll liabilities / Cash) and
  locks the run permanently. Employer contributions (NSSF/WCF/SDL) are
  shown as information. Statutory rates are configurable defaults —
  **verify them against current TRA/NSSF tables before first live run**.
- **Inventory [0022+]** (`/inventory`): school store — items, stock in/out
  (append-only movements; stock can't go negative), low-stock flags.

### 6. Boarding / operations staff (via leadership roles)

- **Hostel [0019+]** (`/hostel`): hostels are gender-typed (male/female/
  mixed) with rooms and capacities. Allocate boarders (day students are
  refused; gender mismatches are refused; full rooms are refused);
  transfers re-allocate atomically; occupancy bars show fill.
- **Transport [0020+]** (`/transport`): routes with ordered stops and an
  informational fee, per-student route+stop assignment, per-route roster.
  (Route fees are invoiced through Finance separately.)
- **Library [0021+]** (`/library`): book catalogue with copy counts, loans
  with due dates (default 14 days), returns, overdue list with days late.
- **Clinic [0023+]** (`/clinic`): record visits (symptoms, treatment,
  notes); tick "notify guardian" to send the primary guardian a Kiswahili
  SMS in the same transaction — parents hear it from the school first.

### 7. Parents / guardians — `/portal`

Parents are invited from the student record ("Invite parent" — requires an
email on the guardian). They are **not** school members: their account only
reaches the portal, which shows only *their* children.

- Per child: class, attendance summary, fee balance, and term report cards
  (published results only).
- SMS arrives automatically (Kiswahili): absence alerts, fee reminders with
  the amount due, clinic-visit notices, school announcements.
- One guardian account covers all their children, even in different classes.

---

## Part IV — The AI assistant ("Ask ATLAS")

Available on **every page** via the floating button (or `/assistant`).
Two layers, both scoped to the asking user's role:

- **Read tools** (the model's ONLY window into data — 28 in all): school
  overview, student counts/search/profile, attendance summaries, absentees,
  fee collections, outstanding fees, invoices, trial balance, assessment
  progress, subscription usage, report generation, staff search, import job
  status, recent announcements with delivery stats — plus **[0016+]**:
  timetable, debtors, CA summaries, academics setup, guardians search,
  recent admissions, hostel occupancy, transport routes, library overdues,
  inventory stock, clinic visits, payroll summary (aggregates only — the AI
  never sees individual salaries). Financial tools call the same
  ledger-reconciled SQL as printed reports, so AI numbers always match.
- **Actions** — the AI *proposes*, a human confirms (17 in all): record
  payment, create invoice, admit student, link a guardian to a student,
  invite staff, send announcement, send fee reminders, create an assessment
  shell (teachers still enter the marks), **[0016+]** set timetable slot,
  set invoice instalments, assign combination, allocate hostel bed, assign
  transport, loan book, return book, record stock movement, record clinic
  visit. Nothing executes until you press **Confirm** on the preview card
  (single-use, 10-minute expiry, permission re-checked at confirm).
  The AI can never: reverse payments, change grades, publish results, post
  payroll, suspend accounts, delete anything, or change plans.

**Monthly token quota:** each plan includes an AI token allowance — Trial
500k, Msingi 2M, Kati 5M, Juu 10M tokens per calendar month. When a school
exhausts it, chat requests are refused with `AI_QUOTA_EXCEEDED` until the
new month starts (platform staff can see each school's token spend under
**Unit costs** on `/platform`, and a plan upgrade raises the allowance
immediately).

Every tool call and action is audited (`ai_tool_calls`,
`ai_proposed_actions`, `audit_logs`). Quality gate: `eval-ai.mjs` must stay
100% on security categories before any AI change ships.

---

## Part V — Operations runbook (platform staff)

### Running the stack

```bash
pnpm install
set -a && source .env && set +a          # root .env holds all secrets

pnpm --filter @atlas/api dev             # API on :4000
pnpm --filter @atlas/web dev             # web (use -p 3001 on the dev Mac)
pnpm --filter @atlas/workers build       # then run the workers you need:
node apps/workers/dist/main.js           # BullMQ workers (needs Redis)
node apps/workers/dist/drain-outbox.js   # SMS outbox (no Redis needed)
node apps/workers/dist/process-imports.js
node apps/workers/dist/process-reports.js

pnpm --filter @atlas/mobile start        # mobile dev server (QR for Expo Go)
```

Mobile specifics: copy `apps/mobile/.env.example` → `.env` (Supabase URL +
anon key; API URL only for staging/prod — in dev the phone auto-finds the
API on the LAN, so the API must be running and the phone on the same
Wi-Fi). Test on a real phone by scanning the QR with the iPhone Camera or
the scanner inside Expo Go on Android. Store builds and submission
(`eas init` → `eas build` → `eas submit`), the push-notification setup and
the store checklist live in `apps/mobile/README.md`. Device push tokens
land in `device_tokens` (migration **0028**, API-only) — sending pushes is
a future worker; nothing sends yet.

Every worker accepts `--once` (drain then exit) — used by smokes. BullMQ
only accelerates pickup; the DB is the source of truth, so a Redis outage
delays jobs but never loses them.

### Configuration (root `.env`; `.env.example` documents every key)

- `SUPABASE_SERVICE_ROLE_KEY` — API/workers only. **Never** in the browser.
- `WEB_ORIGIN` — required in production (invite links + CORS fail fast).
- `SMS_DRIVER` — `console` (dev) or `beem` (+ `BEEM_*` keys).
- `MOONSHOT_API_KEY` / `MOONSHOT_MODEL` — AI provider (`kimi-k2.6`; rejects
  non-default temperature, we send none). `AI_DRIVER=mock` for tests.
- `SENTRY_DSN` — production error alerting.
- `ONBOARD_RATE_LIMIT` — per-IP tenant creations/minute (default 6).
- `HEALTH_TOKEN` — set in production: the detailed health subroutes then
  require `Authorization: Bearer <token>`; unset (dev) they stay open.

### Monitoring

- `GET /api/v1/health` — API up, always public (load balancers);
  `/health/database`, `/health/redis` — dependencies; `/health/workers` —
  heartbeats + failed jobs; `/health/outbox` — SMS backlog (alert if
  `failed > 0` or oldest pending > 15 min). The four detailed subroutes are
  gated by `HEALTH_TOKEN` when it is set. See
  `docs/audit/ATLAS_MONITORING.md`.
- 5xx responses return only a stable error code to clients — the full
  database error text is in the server logs (search by `request_id`).
- Logs are structured JSON with `request_id` (echoed as `x-request-id` —
  ask bug reporters for it).

### Backups, restore & release

- Restore procedure (tested): `docs/audit/ATLAS_RESTORE_RUNBOOK.md`. Repeat
  quarterly; delete dumps afterwards — they contain real PII. (macOS
  gotcha: start the scratch cluster with `LC_ALL=en_US.UTF-8`.)
- Release gate: `pnpm turbo run lint typecheck test build`, the full smoke
  suite (`apps/api/scripts/smoke-*.mjs`, 24 suites), and `eval-ai.mjs`.
  Migrations are additive; shadow-test before live (runbook), apply in
  order.
- Payments/mobile-money integration is **planned, not built** — the full
  design is `docs/product/PAYMENTS_INTEGRATION_PLAN.md`.

### Demo school

"Chief Sarwatt School" (`chief-sarwatt`) is seeded for demos
(`apps/api/scripts/seed-demo.mjs`, idempotent). One-click demo login on the
login page; role accounts (`mwalimumkuu@`, `mwalimu@`, `bursar@`, `kaimu@`,
`mzazi@` … all `@chiefsarwatt.sc.tz`) share the demo password in the seeder.
Note: all seeded assessments are **published** (marks locked) — create a new
assessment to demo mark entry. The tenant sits at status `configuration`;
graduate it to `live` from `/platform` when demoing the health dashboard.
