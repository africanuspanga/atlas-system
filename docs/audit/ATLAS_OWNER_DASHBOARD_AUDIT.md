# ATLAS owner/platform control-centre audit

_Updated 3 August 2026 · status: built and live-verified; operations still need
deployment._

## Implemented

`/platform` is guarded by a separate `profiles.platform_role` model. Tenant
membership never grants platform access and ordinary users cannot assign or
change their own platform role.

Read-capable platform roles can inspect:

- schools by lifecycle and current operational totals;
- current subscription state, plan, MRR, paying schools, and trials expiring;
- school health/activity/headcounts;
- per-school SMS/AI usage and unit-cost signals;
- platform and tenant audit trails.

The 3 August metric hardening uses non-archived tenants and the latest
subscription per tenant for operational totals. Archived smoke tenants and old
subscription rows no longer inflate MRR, students, staff, guardian, SMS,
import, or report-failure metrics. Status breakdown can still expose archived
counts for historical oversight.

## Mutations

`super_admin` can, with required reasons/validation:

- suspend and reactivate to a chosen lifecycle stage;
- change plan/billing cycle while preserving subscription history;
- extend a genuine trial without downgrading a paying school;
- record a reconciled school subscription payment and extend paid-through dates;
- archive a tenant, with an additional force requirement for a live school.

Tenant creation atomically provisions a 30-day trial. TenantGuard enforces
suspension, lapsed/expired read-only posture, student/staff caps, SMS caps, and
AI monthly tokens server-side. Actions write `platform_audit_logs` and a tenant
audit mirror.

## Authorization matrix

| Platform role        | Aggregate/audit reads |      Tenant/plan/payment mutations       |
| -------------------- | :-------------------: | :--------------------------------------: |
| `super_admin`        |          ✅           |                    ✅                    |
| `support`            |          ✅           |                    ❌                    |
| `finance`            |          ✅           | ❌ unless separately implemented/granted |
| `implementation`     |          ✅           |                    ❌                    |
| `auditor`            |          ✅           |                    ❌                    |
| ordinary school user |          ❌           |                    ❌                    |

The definitive guard, not hidden UI, enforces this matrix.

## Verification

`smoke-platform.mjs` covers atomic trial creation, school-owner denial,
support read-only behavior, suspend/reactivate, plan caps, expired/lapsed
read-only access, trial extension, onboarding throttling, audit trails, manual
subscription payment, archive force, and cleanup.

`smoke-platform-metrics.mjs` covers revenue/health/unit-cost aggregates. The
go-live SQL regression and direct metric query verify archived-tenant scoping.

## Current operating state

After test cleanup the linked project contains one school in `configuration`,
zero `live` schools, and archived historical/test tenants. Current MRR is zero.
Open paid onboarding must remain disabled until the release-readiness
infrastructure/compliance gates are complete.

## Remaining platform work

- Production hosting/domain and persistent workers are not configured.
- Automatic payment-provider webhooks/reconciliation are not built; subscription
  payments are manually reconciled and recorded.
- Support impersonation is not built. If added, require explicit permission,
  written reason, short expiry, visible banner, original actor identity, per-
  action audit, revocation, and sensitive-action restrictions.
- Subscription invoicing/tax documents, automated renewal reminders, failed-SMS
  drill-down, churn/ARR/LTV snapshots, support tickets, and provider costs need
  product/operations follow-up.
- Platform role grants remain an owner-controlled administrative operation;
  establish a documented approval/review process before hiring support staff.
