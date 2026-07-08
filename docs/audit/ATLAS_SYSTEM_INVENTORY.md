# ATLAS System Inventory

_Audit date: 2026-07-05 · Branch: `audit/production-readiness` · Tag: `v0.1.0-pre-audit`_

This inventory documents what exists, verified against the codebase and the
live Supabase project — not against the roadmap. Where a claim is proven by an
automated test, the test is named.

## Applications

| App | Path | Stack | Status |
|-----|------|-------|--------|
| School dashboard (web) | `apps/web` | Next.js 16.2, React 19, Tailwind v4, shadcn | Built, dynamic-rendered per request |
| API | `apps/api` | NestJS 11 | Built; guards + zod on every mutation |
| Workers | `apps/workers` | BullMQ + standalone outbox drainer | Outbox drainer live; BullMQ queues are fail-loud placeholders (no producers yet) |
| Parent portal | `apps/web/src/app/portal` | part of web app | Live, non-member auth model |
| Marketing website | — | — | **Not built** |
| ATLAS owner/platform dashboard | — | — | **Not built** (see ATLAS_OWNER_DASHBOARD_AUDIT.md) |
| Student portal | — | — | **Not built** (student role exists, no permissions/UX) |
| Mobile app | — | — | **Not built** |

## Shared packages

`packages/config`, `packages/contracts`, `packages/validation` — thin, present, low content.

## Database

Live Supabase project `zwbsyiwtrabpysylyaaj` (eu-west-3, Postgres 17). Migrations `0001`–`0010`. RLS on every tenant table; append-only `audit_logs`; financial records immutable at the DB level as of `0010`.

## Module status

Legend: ✅ done & tested · 🟡 partial · ❌ missing · N/A not applicable.
"Tested" = covered by an automated smoke/isolation test in `apps/api/scripts`.

| Module | UI | API | DB | Permissions | Audit log | Automated test | Pilot-ready |
|--------|----|----|----|-------------|-----------|----------------|-------------|
| Auth & onboarding | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-onboarding` | ✅ |
| Students & guardians | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-students` | ✅ |
| Excel import (students) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-students` | 🟡 single-domain only; no staging table |
| Staff & invitations (RBAC) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-students` | ✅ |
| Attendance | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-attendance` | ✅ |
| Assessments & report cards (NECTA) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-assessments` | ✅ |
| Finance (invoices/payments/ledger) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-finance` | ✅ |
| Accounting (trial balance/journal) | ✅ | N/A (RLS reads) | ✅ | 🟡 no dedicated `finance.reports.view` gate on page | N/A | 🟡 via `smoke-finance` ledger asserts | 🟡 |
| Communication (SMS announcements) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-communication` | ✅ |
| Outbox drain worker | N/A | N/A | ✅ | N/A | N/A | ✅ `smoke-communication`,`smoke-parents` | ✅ (console driver); 🟡 Beem untested against live gateway |
| Parent portal | ✅ | ✅ | ✅ | ✅ (non-member model) | ✅ | ✅ `smoke-parents` | ✅ |
| Fee reminders | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `smoke-parents` | ✅ |
| Dashboard (real data) | ✅ | N/A (RLS reads) | ✅ | 🟡 relies on RLS | N/A | ❌ | 🟡 unbounded reads (perf) |
| Cross-tenant isolation | N/A | N/A | ✅ | ✅ | N/A | ✅ `smoke-isolation` | ✅ |
| Health/monitoring (mig —) | N/A | ✅ | N/A | N/A (public, counts only) | N/A | ✅ `smoke-health` (live) | ✅ |
| Staged import pipeline (mig 0011) | ✅ | ✅ | ✅ | ✅ `imports.manage`+domain | ✅ | ✅ `smoke-imports` (live, incl. idempotent re-run) | ✅ |
| Reporting/PDF/CSV/XLSX (mig 0012) | ✅ | ✅ | ✅ (ledger-reconciling RPCs) | ✅ `reports.generate`+per-report | ✅ | ✅ `smoke-reports` (live, incl. tamper-refusal) | ✅ |
| Platform control centre + subscription enforcement (mig 0013) | ✅ `/platform` | ✅ | ✅ | ✅ platform_role; caps in TenantGuard | ✅ (platform log + tenant mirror) | ✅ `smoke-platform` (live) | ✅ |
| AI assistant (mig 0014) | ✅ `/assistant` | ✅ | ✅ | ✅ per-tool role checks | ✅ (tool calls + usage) | ✅ `smoke-ai` (live, mock provider) | 🟡 GA gated on full eval suite |
| Timetable / Payroll / Admissions funnel / Library / Transport / Hostel | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ nav links exist, no implementation |

## Honest completion picture

_Updated 2026-07-08 (evening)._ Ten core modules plus the four new pillars —
**staged import pipeline, ledger-reconciled reporting/export, platform control
centre with subscription enforcement, AI assistant** — are now end-to-end
verified against the LIVE database: migrations 0011–0014 applied (14/14 in
history) and **all 13 smoke suites green**. Monitoring/health endpoints are
live; the restore test has been performed and passed. AI GA remains gated on
the full CTO §11 eval suite passing with the real provider. Still not built:
marketing website, student portal, mobile app,
timetable/payroll/library/transport/hostel modules, payment webhooks (no
provider integration yet).

## Roles defined vs. wired

12 system roles seeded. `role_permissions` populated for: school_owner/director (superusers in guard), head_teacher, school_admin, academic_master, bursar, accountant, cashier, teacher, class_teacher. **Not wired:** `parent` (uses the non-member portal model instead — correct), `student` (no portal yet).
