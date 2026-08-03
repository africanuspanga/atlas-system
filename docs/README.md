# ATLAS documentation

Use this page as the entry point for current operating documentation. Dated
audit evidence is retained for traceability, but it does not override the
current go-live report or runbooks.

## Start here

- [Go-live readiness](audit/GO_LIVE_READINESS_2026-08-03.md) — current release
  decision, evidence, blockers, and release sequence.
- [Architecture overview](architecture/overview.md) — applications, trust
  boundaries, multi-tenancy, finance, AI, and background jobs.
- [Administrator guide](ADMIN_GUIDE.md) — school-owner, staff, parent, AI, and
  platform operations.
- [Testing guide](ATLAS_TESTING_GUIDE.md) — sequential quality gates, database
  rehearsal, live-connected smokes, AI evaluation, and manual acceptance.
- [Pilot runbook](audit/ATLAS_PILOT_RUNBOOK.md) — controlled school onboarding,
  cutover, rollback, and promotion.

## Production operations

- [Release readiness checklist](audit/ATLAS_RELEASE_READINESS.md)
- [Monitoring and alerting](audit/ATLAS_MONITORING.md)
- [Incident response](audit/ATLAS_INCIDENT_RESPONSE.md)
- [Restore runbook](audit/ATLAS_RESTORE_RUNBOOK.md)
- [Security audit](audit/ATLAS_SECURITY_AUDIT.md)
- [Tanzania privacy checklist](audit/TANZANIA_PRIVACY_CHECKLIST.md)
- [Tenant-isolation audit](audit/ATLAS_TENANT_ISOLATION_AUDIT.md)
- [Owner-dashboard audit](audit/ATLAS_OWNER_DASHBOARD_AUDIT.md)
- [System inventory](audit/ATLAS_SYSTEM_INVENTORY.md)
- [Performance audit](audit/ATLAS_PERFORMANCE_AUDIT.md)

## Product specifications

- [AI assistant specification](audit/ATLAS_AI_ASSISTANT_SPEC.md)
- [Import pipeline specification](audit/ATLAS_IMPORT_PIPELINE_SPEC.md)
- [Reporting specification](audit/ATLAS_REPORTING_SPEC.md)
- [External payments integration plan](product/PAYMENTS_INTEGRATION_PLAN.md)

## Commercial drafts

The files under `sales/` are internal pre-launch drafts. Do not distribute them
until the open-onboarding blockers in the go-live report are closed and the
claims are re-checked against production behavior.

## Historical evidence

The July handover, deep bug hunt, code review, bug register, and fix log are
snapshots of earlier states. Each retained historical file carries a superseded
notice. Do not use old migration counts, test totals, or release decisions as
current instructions.
