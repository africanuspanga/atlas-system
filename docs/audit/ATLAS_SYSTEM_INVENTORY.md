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
| AI assistant | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ **not started** (spec: ATLAS_AI_ASSISTANT_SPEC.md) |
| Reporting/PDF/CSV export | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ **not started** (spec: ATLAS_REPORTING_SPEC.md) |
| Timetable / Payroll / Admissions funnel / Library / Transport / Hostel | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ nav links exist, no implementation |

## Honest completion picture

Ten modules are genuinely end-to-end (UI → API → DB → permissions → audit → automated test). The three items the CTO letter emphasises most — **owner/platform dashboard, AI assistant, and the reporting/export system** — are **not yet built**; specs are written in this folder. "80% complete" overstates readiness: by workflow count, the operational core for a single pilot school is solid, but the SaaS-platform layer and the two AI/reporting pillars are greenfield.

## Roles defined vs. wired

12 system roles seeded. `role_permissions` populated for: school_owner/director (superusers in guard), head_teacher, school_admin, academic_master, bursar, accountant, cashier, teacher, class_teacher. **Not wired:** `parent` (uses the non-member portal model instead — correct), `student` (no portal yet).
