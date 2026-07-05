# ATLAS Tenant Isolation Audit

_Audit date: 2026-07-05 · Automated proof: `apps/api/scripts/smoke-isolation.mjs`_

Tenant isolation is the single most important security property for a
multi-school SaaS. This audit both reviews the design and **proves it with an
automated attack suite** that runs like any other smoke test.

## Design

Three independent layers, any one of which alone would prevent cross-tenant access:

1. **RLS** on every tenant table (`app.is_tenant_member(tenant_id)`), so even a
   valid user's own Supabase session returns zero rows for another school.
2. **API `TenantGuard`** resolves the tenant from the `x-tenant-id` header,
   verifies the caller has an *active membership* in that tenant, loads role
   permissions, and enforces `@RequirePermission`. The frontend cannot assert a
   tenant it is not a member of.
3. **RPC parameter scoping** — every business RPC takes `p_tenant_id` and filters
   entity ids against it, so passing another school's id fails inside Postgres.

The service-role key is confined to `apps/api/src/supabase`, `apps/workers`, and
dev-only scripts. It never reaches the browser (`NEXT_PUBLIC_*` carries only the
URL and anon key).

## Automated attack suite — `smoke-isolation.mjs`

Builds School A and School B (each with a student, guardian, invoice, payment),
then attempts every crossing. **All pass** (2026-07-05):

| # | Attack | Result |
|---|--------|--------|
| 2 | A's owner SELECTs B's rows across 14 tables via own Supabase session | 0 rows every table |
| 3 | A's owner UPDATE/DELETE B's student & invoice via own session | No change (RLS blocks) |
| 4 | A's token + B's `x-tenant-id` header on 5 mutating endpoints | 403 every endpoint |
| 5 | A (legit A member) passes B's section/student/fee/payment/guardian ids to 10 RPC-backed endpoints | 400 with clean, specific error codes; no cross-tenant effect |
| 6 | A's linked parent requests B's child report card; reads `students` via own session | 403; 0 RLS rows |
| 7 | Service role UPDATE/DELETE on `payments` and `journal_lines` | Blocked by immutability triggers; amount intact |

Cross-tenant reference codes proven in step 5: `IMPORT_SECTION_NOT_FOUND`,
`ATTENDANCE_SECTION_NOT_FOUND`, `ASSESSMENT_BAD_SECTION_OR_TERM`,
`INVOICE_STUDENT_NOT_FOUND`, `INVOICE_FEE_ITEM_NOT_FOUND`,
`ANNOUNCEMENT_SECTION_NOT_FOUND`, `PAYMENT_INVOICE_NOT_FOUND`,
`REVERSAL_PAYMENT_NOT_FOUND`, guardian invite 404, `REPORT_STUDENT_NOT_FOUND`.

## `tenant_id` coverage

Every table holding school data carries `tenant_id not null`. Verified global
(intentionally no `tenant_id`): `plans`, `plan_features`, `permissions`,
`roles` (system rows), `profiles`. Child tables scoped via FK **and** their own
`tenant_id`: `student_guardians`, `invoice_lines`, `journal_lines`,
`membership_roles`.

## Storage

No Supabase Storage buckets are in use yet (no file uploads implemented).
**Action for the reporting/import milestones:** any bucket introduced must use a
tenant-prefixed path (`{bucket}/{tenant_id}/…`) with a tenant-aware access
policy, and downloads must be served via signed URLs — never public buckets.
Tracked in ATLAS_IMPORT_PIPELINE_SPEC.md and ATLAS_REPORTING_SPEC.md.

## Background jobs

The outbox drainer joins `tenants!inner` and only drains `active`/`configuration`
tenants, so an archived/suspended school never sends queued messages (verified
in `smoke-communication.mjs`). The BullMQ base worker asserts `context.tenantId`
on every job.

## Residual items (P3, tracked in bug register)

- AUD-012: multi-school users get an arbitrary tenant via `limit(1)` — a
  correctness/UX gap, not a leak (RLS + guard hold). Needs a tenant switcher.
- Platform/support staff access is **not yet built**; when added it must be a
  separately-authorised, fully-audited path (see ATLAS_OWNER_DASHBOARD_AUDIT.md).

## Verdict

Tenant isolation is **strong and now regression-tested**. `smoke-isolation.mjs`
should run in CI on every migration or permission change.
