# ATLAS — engineering conventions

Tanzania-first multi-tenant school SaaS. pnpm + Turborepo monorepo:
`apps/web` (Next.js 16, App Router), `apps/api` (NestJS 11, port 4000),
`apps/workers` (BullMQ + standalone DB pollers), `supabase/migrations`.
Operator docs: `docs/ADMIN_GUIDE.md`. Audit history/specs: `docs/audit/`.

## Iron rules

- **Business logic lives in NestJS + Postgres (RPCs/constraints), never in
  React.** The web app renders and calls the API; simple reads may use
  Supabase RLS directly.
- **Tenant scoping is server-side, always.** The API uses the service-role
  key (bypasses RLS) — every query MUST filter by `tenant_id` from
  `TenantGuard` context (`x-tenant-id` header → membership check →
  entitlements → permissions). RLS is the safety net, not the control.
- **Financial records are immutable** (DB triggers). Corrections are
  reversals. Every money movement posts a balanced journal entry. Report SQL
  reconciles to the ledger and raises `REPORT_RECONCILE_FAILED` on mismatch.
- **Migrations are additive-only**, numbered `000000000000NN_name.sql`
  (currently 0001–0015). New `app.*` functions get service-role-only
  `public.*` wrappers (PostgREST exposes only `public`), with explicit
  `revoke`/`grant`. New permission keys need a row in `public.permissions`
  BEFORE `role_permissions` (FK) — and mirror seeds in `supabase/seed.sql`.
  Test DDL against a shadow restore before the live DB (see
  `ATLAS_RESTORE_RUNBOOK.md`); note a schema-only shadow can't catch
  data-dependent seeds.
- **Background jobs: DB is the source of truth, BullMQ is just the kick.**
  Job tables carry status; workers poll + accept BullMQ; every worker has a
  `--once` mode used by smokes. Claims are atomic conditional updates
  (`update … where status='pending'`).
- **AI**: the model only reaches data through the fixed tool catalogue
  (`ai-tools.service.ts`), permission-checked per call, tenant from server
  context. Write operations only via propose→confirm→execute
  (`ai-actions.service.ts`); the confirm endpoint is never model-reachable.
  Never let AI compute financial figures — call the report RPCs.
  Provider: Moonshot `kimi-k2.6` via plain fetch (rejects non-default
  temperature — send none); `AI_DRIVER=mock` for deterministic tests.

## Verification (run before calling anything done)

```bash
pnpm turbo run lint typecheck test build          # must be green
set -a && source .env && set +a                   # root .env, gitignored
node apps/api/scripts/smoke-<module>.mjs          # E2E per module (API must run)
node apps/api/scripts/eval-ai.mjs                 # real-provider AI eval (security cats must be 100%)
```

14 smoke suites exist (`smoke-onboarding` … `smoke-ai-actions`); they create
throwaway tenants against the live dev Supabase project and archive them.
`smoke-ai*` needs the API started with `AI_DRIVER=mock`. Onboarding is
rate-limited (6/min/IP) — space suites out or you'll hit 429s.

## Gotchas learned the hard way

- `class_sections.name` holds the stream label ("A"); there is NO `stream`
  column. Grade name comes from `grade_levels.name`.
- Supabase JS caps reads at 1000 rows — paginate with `.range()` for more.
- eslint's `no-unnecessary-type-assertion` fixer strips `as` casts on
  supabase results; type the destructure target instead.
- Tenants are never hard-deleted (audit_logs FK) — archive
  (`status='archived'`); the outbox join excludes non-active tenants.
- `queue_announcement` takes `p_audience_type`, returns
  `{announcementId, recipients}`.
- Phone/admission numbers are strings (leading zeros); TZ phones normalise
  to `0XXXXXXXXX`.
- Next 16 uses `src/proxy.ts` (named `proxy` export), not `middleware.ts`;
  web env lives in `apps/web/.env.local`.
- macOS has no `timeout`; the dev DB direct host doesn't resolve — use the
  session pooler (`DATABASE_URL`); psql/pg_dump live under
  `/usr/local/opt/postgresql@17/bin`.
- New user-facing strings get EN + SW keys in `apps/web/src/i18n/index.ts`.

## House patterns (copy an existing file, don't invent)

- API endpoint: controller w/ `@UseGuards(AuthGuard, TenantGuard)` +
  `@RequirePermission('x.y')`, zod `safeParse` on every body, business errors
  as `{ code: 'STABLE_CODE' }` 400s (see `finance.controller.ts`).
- Web page: server `page.tsx` (auth + tenant redirect) + `"use client"` view
  using `apiFetch` (see `apps/web/src/app/staff/`).
- Smoke test: `apps/api/scripts/smoke-*.mjs` — plain node, creates users via
  service role, asserts status codes AND database state, archives the tenant.
- Migration: RLS enable + "members read" policy per tenant table; writes go
  through the API.
