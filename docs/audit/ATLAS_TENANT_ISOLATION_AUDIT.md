# ATLAS tenant-isolation audit

_Updated 3 August 2026 · automated suite:
`apps/api/scripts/smoke-isolation.mjs`._

Tenant isolation is the primary security property of ATLAS. The current design
uses independent UI-correctness, API-authorization, RLS, RPC, and constraint
layers; no single client-supplied tenant value is trusted.

## Layers

1. **Active tenant selection:** web pages use `active-tenant.ts` and a validated
   HTTP-only tenant cookie. Users can switch only to a school they can read.
2. **API guard:** `x-tenant-id` is accepted only after active membership,
   tenant lifecycle, subscription, plan, and permission checks.
3. **Service-role scoping:** every sensitive query/RPC filters by the guard's
   tenant. Lookups fail closed on database/auth errors.
4. **RLS:** direct browser/PostgREST access is tenant-status and permission
   aware. Parents use linked-child policies rather than a staff membership.
5. **Database ownership checks:** child records and cross-references carry or
   verify tenant ownership; mismatched ids fail inside RPCs/triggers.
6. **Platform separation:** `platform_role` is independent from school roles,
   cannot be self-assigned, and platform actions are separately audited.

The service-role key is confined to API/workers/approved scripts and is never a
browser or mobile variable.

## Current adversarial evidence

The two-school isolation suite proves:

- owner A reads zero tenant-owned rows from school B under their own JWT;
- owner A cannot update/delete B's records through direct Supabase access;
- A's JWT plus B's `x-tenant-id` is rejected across protected endpoints;
- cross-tenant entity ids fail without side effects inside business RPCs;
- a parent cannot retrieve another child/report card;
- service-role attempts to mutate immutable finance records are rejected.

Additional live post-migration JWT probes on 3 August proved:

- linked parent: zero students/invoices outside their links and one own guardian
  row;
- pure teacher: only authorized students, zero invoices, zero guardians;
- finance user: authorized invoices only for their tenant;
- anon/authenticated: zero ability to update `profiles.platform_role`;
- no unintended RLS-enabled public table with zero policies.

The parent policies fixed the previously dangerous broad-member model, and the
tenant-status policies prevent former staff from continuing to browse an
archived/suspended school under an old token.

## Background jobs and AI

- Durable job/outbox rows carry `tenant_id`; atomic claims preserve that scope.
- Outbox claiming excludes tenants that should not send and applies plan caps.
- AI tenant/user/permission context is built by the server. The model cannot
  provide or override tenant ids.
- The real-provider eval passed cross-tenant and injection cases without data
  leakage. Proposals/confirmations are user- and tenant-bound.

## Storage and exports

Import/report Storage objects use private tenant-prefixed paths and signed
downloads. New buckets must remain private and encode tenant ownership in both
path and policy. Export generators escape spreadsheet formulas and must never
produce a cross-tenant aggregate outside the guarded platform/report service.

## Regression rules

- Test RLS as `authenticated` with a JWT claim inside a transaction; Postgres
  superusers and service-role sessions bypass RLS and prove nothing.
- Run `smoke-isolation.mjs` after every permission, membership, parent, tenant
  lifecycle, policy, Storage, or service-role query change.
- Rehearse all migrations and inspect for RLS-enabled tables with zero policies.
- Include at least owner, pure teacher, class teacher, finance, linked parent,
  support, and platform super-admin in manual acceptance.
- Never “fix” an empty result by broadening member-read policies. Determine the
  required permission/scope and add a specific tested rule.

## Residual risks

- Service-role code has broad database power; missing tenant filters remain a
  severe code-review category even with RLS as the browser safety net.
- Platform aggregates intentionally cross tenants and must stay aggregate-only
  without PII.
- Browser/device E2E coverage is not exhaustive; pilot role walkthroughs remain
  required.
- Hard deletion is not a tenant-offboarding mechanism. Archive/suspend access,
  then follow approved retention/deletion procedures.
