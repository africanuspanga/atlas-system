# ATLAS architecture overview

## System shape

```
┌─────────────────────────────────────────────┐
│                 Client Layer                │
│ Next.js Web │ Parent App │ Staff App │ PWA │
└──────────────────────┬──────────────────────┘
                       │ HTTPS
┌──────────────────────▼──────────────────────┐
│                NestJS API                   │
│ Auth Context │ Modules │ Validation │ RBAC │
│ Workflows │ OpenAPI │ Webhooks │ Auditing  │
└───────┬─────────────┬───────────────┬───────┘
        │             │               │
┌───────▼──────┐ ┌────▼─────┐ ┌──────▼────────┐
│ Supabase     │ │ Redis /  │ │ External      │
│ Postgres     │ │ BullMQ   │ │ Providers     │
│ Auth/Storage │ │ Workers  │ │ Payments/SMS  │
└──────────────┘ └──────────┘ └───────────────┘
```

## Multi-tenancy

Shared database, shared schema. Every tenant-owned table carries
`tenant_id uuid not null`; campus-scoped rows also carry `campus_id`.

- RLS is enabled on every tenant-owned table (see `supabase/migrations/`).
- `app.is_tenant_member(tenant_id)` is the reusable policy helper.
- The API connects with the service role (bypasses RLS) and enforces
  permissions in guards; RLS protects any direct PostgREST/Realtime access.
- JWTs carry only a coarse platform role. Detailed permissions live in
  Postgres (`roles`, `permissions`, `role_permissions`, `membership_roles`)
  and are resolved per request for the active tenant.

## Identity model

- `profiles` — one per auth user, global (a parent can belong to several schools).
- `tenant_memberships` — links a user to a tenant, with status and optional
  campus restriction.
- `membership_roles` — roles per membership; roles map to granular
  `domain.action` permission keys with a scope
  (`own | class | department | campus | tenant | platform`).

## Background jobs

All heavy or async work goes through BullMQ queues (`apps/workers`):
report generation, bulk invoicing, SMS/email/push, imports, reconciliation,
exports. Every job payload carries `{ context: { tenantId, actorUserId } }` —
workers refuse jobs without tenant context.

## Auditing

`audit_logs` is append-only (update/delete blocked by trigger). Every
sensitive change records actor, action, entity, before/after and request id.

## Migration discipline

The database is defined by version-controlled SQL in `supabase/migrations/` —
schema, constraints, RLS policies, triggers and functions all live there.
No ORM migration file is the source of truth.

## Milestone status

- [x] Monorepo (pnpm + Turborepo)
- [x] Migration 0001: control plane + identity + RLS + audit log
- [ ] Supabase Auth integration in web + api
- [ ] Tenant onboarding wizard
- [ ] Academic structure (years, terms, classes, streams, subjects)
- [ ] Students + guardians
- [ ] Excel import engine
- [ ] EN/SW localisation foundation
