# ATLAS API

NestJS 11 business API for ATLAS. It owns server-side authorization and the
business workflows that must not live in React: onboarding, invitations,
finance, attendance, assessments, imports, reporting, school operations,
payroll, platform administration, and AI tools/actions.

## Run locally

Load the root environment file before starting the API:

```bash
set -a && source ../../.env && set +a
pnpm start:dev
```

The API defaults to `http://localhost:4000/api/v1`. Production starts the built
artifact with:

```bash
pnpm build
pnpm start:prod
```

`NODE_ENV=production` intentionally fails startup when `WEB_ORIGIN`, Supabase
server credentials, the real AI provider, or other required production values
are unsafe or missing. `AI_DRIVER=mock` is test-only.

## Request security model

Protected school endpoints use this order:

1. `AuthGuard` validates the Supabase access token with Supabase Auth.
2. `TenantGuard` resolves `x-tenant-id`, active membership, tenant lifecycle,
   subscription entitlements, plan limits, and permission keys.
3. The controller validates body/query inputs with Zod.
4. Service-role queries always filter by the server-resolved tenant.

Platform endpoints use a separate `PlatformGuard`. School membership never
grants a platform role. Detailed behavior is in the
[security audit](../../docs/audit/ATLAS_SECURITY_AUDIT.md).

## AI

The AI agent can only access data through the fixed tool catalogue. Every tool
receives server-derived user/tenant/permission context. Write tools create
short-lived, user-bound proposals; only `POST /ai/actions/:id/confirm` can
execute them, and permissions are rechecked at confirmation.

## Health and observability

- `GET /api/v1/health` — public liveness
- `GET /api/v1/health/database`
- `GET /api/v1/health/redis`
- `GET /api/v1/health/workers`
- `GET /api/v1/health/outbox`

Set `HEALTH_TOKEN` in production; the detailed routes then require a Bearer
token. Logs are structured and include `request_id`; `SENTRY_DSN` enables 5xx
reporting. See [monitoring](../../docs/audit/ATLAS_MONITORING.md).

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The live-connected suites in `scripts/smoke-*.mjs` create isolated test
tenants, assert API and database state, then archive them. Run instructions and
the real-provider AI gate are in the
[testing guide](../../docs/ATLAS_TESTING_GUIDE.md).
