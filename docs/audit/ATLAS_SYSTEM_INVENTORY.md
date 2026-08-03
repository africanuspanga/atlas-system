# ATLAS system inventory

_Verified against the repository and linked Supabase project on 3 August 2026._

Legend: ✅ built and verified · 🟡 built/partial or needs external operations ·
❌ not built.

## Applications

| Surface                      | Path                           |        Status         | Notes                                                             |
| ---------------------------- | ------------------------------ | :-------------------: | ----------------------------------------------------------------- |
| School web dashboard         | `apps/web`                     |          ✅           | Next.js 16; role/tenant-aware school modules                      |
| Parent portal                | `/portal`                      |          ✅           | non-member guardian model; linked children only                   |
| AI assistant                 | `/assistant` + global launcher |          ✅           | permission-scoped reads and propose/confirm actions               |
| ATLAS control centre         | `/platform`                    |          ✅           | portfolio/revenue/health/costs and audited tenant actions         |
| Business API                 | `apps/api`                     |          ✅           | NestJS 11; Zod, Auth/Tenant/Platform guards                       |
| Queue/import/report workers  | `apps/workers`                 |  ✅ code / 🟡 deploy  | Redis/BullMQ + DB-backed state; no production heartbeat yet       |
| SMS outbox drainer           | `apps/workers`                 | ✅ code / 🟡 provider | Beem driver exists; credentials/live delivery not verified        |
| Native mobile app            | `apps/mobile`                  | ✅ core / 🟡 release  | Expo staff/parent flows; EAS/store/device acceptance pending      |
| Marketing/public signup site | —                              |          ❌           | sales docs exist; unrestricted self-service launch not approved   |
| Student portal               | —                              |          ❌           | student role concept exists, no portal                            |
| Payment-provider webhooks    | —                              |          ❌           | manual app payments are idempotent; external plan documented      |
| Push-notification sender     | —                              |          ❌           | secure device-token registration exists; delivery worker deferred |
| Support impersonation        | —                              |          ❌           | deliberately deferred; platform actions remain direct/audited     |
| Tenant document RAG          | —                              |          ❌           | structured AI tools exist; document ingestion/retrieval not built |

## Database

- Migrations `0001`–`0033` are applied to the linked project.
- 71 public tables, 60 RLS policies, 217 app/public functions.
- No unintended RLS-enabled table without a policy in the full shadow.
- Financial immutability, balanced journals, tenant ownership, payroll
  verification, payment idempotency/date rules, outbox claiming, and
  platform-metric scoping are database enforced.
- Existing/future tenants have payroll settings; each school's settings remain
  unusable for payroll until professionally reviewed and verified.

## School modules

| Module                                   | Web/API/DB | Primary verification                                   |            Readiness            |
| ---------------------------------------- | :--------: | ------------------------------------------------------ | :-----------------------------: |
| Auth, onboarding, academic structure     |     ✅     | `smoke-onboarding`, `smoke-lifecycle`                  |               ✅                |
| Multi-school tenant switching            |     ✅     | code/build + role walkthrough required                 |            ✅ pilot             |
| Students, guardians, enrolment lifecycle |     ✅     | `smoke-students`, `smoke-lifecycle`, `smoke-isolation` |               ✅                |
| Staff, invitations, RBAC                 |     ✅     | onboarding/students/platform/isolation suites          |               ✅                |
| Attendance and absence outbox            |     ✅     | `smoke-attendance`, communication                      |        ✅ code / 🟡 SMS         |
| Assessments/report cards/NECTA           |     ✅     | `smoke-assessments`, `smoke-necta`                     |               ✅                |
| Timetable                                |     ✅     | `smoke-timetable`                                      |               ✅                |
| Finance, instalments, debtors, ledger    |     ✅     | finance/instalments/isolation/regression               |         ✅ manual entry         |
| Accounting/report exports                |     ✅     | `smoke-reports`, finance                               |               ✅                |
| Payroll                                  |     ✅     | `smoke-payroll`, SQL regression                        |  🟡 per-school accountant gate  |
| Imports                                  |     ✅     | `smoke-imports`                                        |   ✅ pilot with signed totals   |
| Communication/SMS                        |     ✅     | `smoke-communication`, parent/clinic                   |       🟡 Beem operations        |
| Parent portal                            |     ✅     | `smoke-parents`, isolation                             |               ✅                |
| Hostel                                   |     ✅     | `smoke-hostel`                                         |               ✅                |
| Transport                                |     ✅     | `smoke-transport`                                      |               ✅                |
| Library                                  |     ✅     | `smoke-library`                                        |               ✅                |
| Inventory                                |     ✅     | `smoke-inventory`                                      |               ✅                |
| Clinic                                   |     ✅     | `smoke-clinic`                                         |    ✅ with privacy controls     |
| Platform subscriptions/lifecycle         |     ✅     | `smoke-platform`, `smoke-platform-metrics`             |        ✅ manual billing        |
| AI agent                                 |     ✅     | AI smokes + real eval 40/40                            |  🟡 privacy/latency/cost gate   |
| Health/observability                     |  ✅ code   | `smoke-health`                                         | 🟡 Sentry/workers/alerts deploy |

## Roles

System roles include school owner, director, school admin, head teacher,
academic master, bursar, accountant, cashier, teacher, and class teacher.
Permissions are sourced from `supabase/seed.sql` and enforced by API guards and
permission-aware RLS. Parents use linked guardian records rather than staff
membership. Platform roles are independent and cannot be self-assigned.

## Verification snapshot

- 25/25 live-connected product smoke suites passed.
- Real Moonshot evaluation passed 40/40; security categories 100%.
- Lint 3/3, typecheck 7/7, tests 4/4, builds 3/3.
- Dependency audit found no known moderate-or-higher issue.

## Production gaps

No production hosting target/domain is recorded in the repository. Current
environment inspection found a local API URL and no Sentry, health token, Beem,
or EAS production configuration. Persistent workers are not deployed. Tanzania
privacy/cross-border AI and payroll sign-offs are outstanding. These are the
reasons open customer onboarding remains a no-go; see the
[current readiness report](GO_LIVE_READINESS_2026-08-03.md) and
[privacy checklist](TANZANIA_PRIVACY_CHECKLIST.md).
