# ATLAS architecture overview

_Current through migration `0033` · updated 3 August 2026._

## System shape

```text
Next.js web ─┐
Expo mobile ─┼─ HTTPS/Bearer token ─ NestJS API ─ service role ─ Supabase
Parent portal┘                         │                         Postgres/Auth/Storage
                                      ├─ Moonshot AI
                                      └─ Redis/BullMQ
                                           ├─ queue worker
                                           └─ SMS outbox drainer ─ Beem
```

The web app may make simple, read-only Supabase queries under the user's JWT;
RLS scopes those reads. Business mutations, sensitive reads, subscription
enforcement, payroll, finance, platform operations, and every AI tool go
through the API. Workers use the database as the durable source of truth;
BullMQ only accelerates pickup.

## Multi-tenancy

ATLAS uses one shared database/schema. Tenant-owned tables carry
`tenant_id uuid not null`; campus-scoped rows also carry `campus_id` where
needed.

Defense is layered:

1. Web users choose a tenant through the tenant switcher. The server validates
   the selected HTTP-only cookie against membership before using it.
2. `TenantGuard` validates `x-tenant-id`, active membership, tenant status,
   subscription state, plan caps, and the endpoint's permission key.
3. Service-role queries and RPCs use the guard's tenant, never a model- or
   client-supplied tenant.
4. RLS protects direct browser/PostgREST access. Policies are tenant-status and
   permission aware; parent policies expose only linked children/guardian rows.
5. Tenant ownership triggers prevent cross-tenant foreign-key relationships.

`school_owner` and `director` are tenant super-roles only. Platform access is a
separate `profiles.platform_role`, guarded against self-escalation and audited.

## Identity and roles

- `profiles` — one global profile per Supabase Auth user.
- `tenant_memberships` — user-to-school membership with lifecycle status and
  optional campus restriction.
- `membership_roles` — one or more roles on a membership.
- `roles`, `permissions`, `role_permissions` — granular `domain.action`
  authorization with scope.
- `guardians.user_id` — parent portal link. Parents are not school staff
  members and only see their linked children.

## Tenant lifecycle and subscriptions

Lifecycle: `draft → configuration → data_review → training → live`, with
`suspended` and `archived` side states. Suspended/archived tenants cannot use
the school API. Expired/lapsed subscriptions become read-only until payment or
extension. Onboarding atomically creates the school structure and a 30-day
trial. Student/staff and AI/SMS limits are enforced server-side.

The `/platform` control centre exposes aggregate portfolio, revenue, health,
and unit-cost views plus audited plan/payment/lifecycle actions. Current
portfolio metrics exclude archived tenants and use the latest subscription per
school.

## Finance and payroll

Financial rows are append-only. Payment, invoice-line, journal, and journal-line
immutability is enforced by database triggers; corrections use reversal rows.
Payment idempotency keys make client retries safe. Financial dates use Tanzania
calendar dates and are validated against invoice issue dates and the current
local day. Report RPCs reconcile to the ledger and refuse mismatches.

Payroll requires tenant-specific statutory settings to be reviewed and marked
verified. Changing rates removes verification. Posting creates separate,
balanced wage and employer-contribution journals and locks the run.

## AI agent

The model has no database credentials and cannot run arbitrary SQL. It receives
only a fixed tool catalogue. Each tool validates arguments, permission, tenant,
scope, and query errors before returning bounded structured data. Sensitive
clinical output is de-identified and payroll output is aggregate-only.

Mutating tools follow:

```text
model proposes → server validates and creates preview → human confirms
→ server rechecks permission/live state → normal business RPC executes → audit
```

The model cannot call the confirmation endpoint. Production rejects the mock
driver. AI usage is metered per tenant/month; real-customer use remains subject
to Tanzania privacy and cross-border-processing approval.

## Background processing

- Import/report job tables persist state; workers claim conditionally and can
  recover stale work.
- SMS outbox rows are claimed atomically, rate/plan limited, retried with
  bounded backoff, and marked sent only after provider success.
- Both the queue worker and outbox drainer write Redis heartbeats read by the
  health API.
- Production must run `@atlas/workers start` and `@atlas/workers drain` as
  separate persistent processes.

## Auditing and observability

`audit_logs` and `platform_audit_logs` are append-only. AI conversations,
tool calls, proposals, confirmations, usage, and failures have dedicated audit
records. API logs are structured and correlated by `request_id`.

Detailed health endpoints cover Postgres, Redis, workers, and the SMS outbox;
they require `HEALTH_TOKEN` in production. Sentry activates through
`SENTRY_DSN`.

## Migration discipline

The database source of truth is `supabase/migrations/0001`–`0033`. New changes
must be additive migrations, rehearsed with `scripts/shadow-migrations.sh`,
then inspected with `supabase db push --dry-run` before application. The linked
live project was verified at `0033` on 3 August 2026.

See the [testing guide](../ATLAS_TESTING_GUIDE.md), [security audit](../audit/ATLAS_SECURITY_AUDIT.md),
and [go-live report](../audit/GO_LIVE_READINESS_2026-08-03.md).
