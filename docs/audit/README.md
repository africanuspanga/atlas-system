# ATLAS audit and operations documents

The authoritative current decision is
[`GO_LIVE_READINESS_2026-08-03.md`](GO_LIVE_READINESS_2026-08-03.md).
It records the migration-33 live state, 25/25 product smokes, 40/40 real AI
evaluation, quality gates, remaining infrastructure/compliance blockers, and
the staged rollout plan.

## Current operating documents

| File                              | Purpose                                                        |
| --------------------------------- | -------------------------------------------------------------- |
| `GO_LIVE_READINESS_2026-08-03.md` | CTO verdict, evidence, blockers, release sequence              |
| `ATLAS_RELEASE_READINESS.md`      | Living go/no-go checklist                                      |
| `ATLAS_PILOT_RUNBOOK.md`          | One-school training/pilot procedure and sign-off               |
| `ATLAS_MONITORING.md`             | Health, logs, Sentry, heartbeats, alerts                       |
| `ATLAS_INCIDENT_RESPONSE.md`      | Severity, containment, privacy decision, recovery and review   |
| `ATLAS_RESTORE_RUNBOOK.md`        | Backup/restore procedure and current restore gap               |
| `ATLAS_SYSTEM_INVENTORY.md`       | What is built now                                              |
| `ATLAS_SECURITY_AUDIT.md`         | Current security controls and residual risks                   |
| `TANZANIA_PRIVACY_CHECKLIST.md`   | PDPC, DPA, transfer, AI, rights, retention and breach sign-off |
| `ATLAS_TENANT_ISOLATION_AUDIT.md` | Tenant/RLS design and attack evidence                          |
| `ATLAS_OWNER_DASHBOARD_AUDIT.md`  | Current platform control-centre capabilities/gaps              |
| `ATLAS_AI_ASSISTANT_SPEC.md`      | Implemented AI architecture, safety, evaluation                |

The repository-wide verification procedure lives at
[`../ATLAS_TESTING_GUIDE.md`](../ATLAS_TESTING_GUIDE.md).

## Historical records

The following are point-in-time evidence. Their original findings, counts, and
commands are intentionally preserved and may be superseded:

- `ATLAS_BUG_REGISTER.md` and `ATLAS_FIX_LOG.md` — July 5 audit
- `ATLAS_CODE_REVIEW_2026-07.md` — detailed July adversarial review
- `HANDOVER_2026-07-31.md` — state before migrations 31–33 and final hardening
- `../ATLAS_DEEP_BUG_HUNT_2026-07-12.md` — July 12 review

Do not use a historical file to decide which migrations to apply or whether a
module is built. Use the testing guide and current go-live report.

## Current evidence snapshot

- Live Supabase migration: `0033`
- Shadow: 71 tables, 60 policies, 217 functions; no unintended deny-all table
- Product/API smokes: 25/25
- Real-provider AI eval: 40/40, security 100%
- Static gates: lint 3/3, typecheck 7/7, tests 4/4, builds 3/3
- Dependency audit: no known moderate-or-higher vulnerability

These results are dated 3 August 2026 and must be regenerated for the release
commit and production environment.
