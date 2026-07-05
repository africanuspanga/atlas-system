# ATLAS Security Audit

_Audit date: 2026-07-05_

Scope: authentication, authorization, secrets, injection, redirects, transport,
dependencies. Tenant isolation has its own document
(ATLAS_TENANT_ISOLATION_AUDIT.md).

## Authentication

- Supabase Auth (JWT). API `AuthGuard` calls `supabase.auth.getUser()` per
  request — no local JWT trust. `TenantGuard` runs after it.
- Membership is resolved from the authenticated session + `x-tenant-id`, and
  requires `status = 'active'` — a revoked member is rejected even mid-session.
- Password min length 8 (Supabase default policy). Email confirmation is ON
  (AUD-023: no transactional email wired — turn off for dev or wire before
  parent self-signup at scale).

**Edge cases reviewed:** expired token (getUser fails → 401), revoked membership
(active check fails → 403), archived tenant (outbox join excludes it; UI reads
return nothing). **Not yet handled explicitly:** subscription expiry/downgrade
enforcement (no billing layer yet — platform milestone), multi-school tenant
selection (AUD-012).

## Authorization

- `@RequirePermission` enforced in `TenantGuard` against `role_permissions`;
  school_owner/director are superusers in code.
- Server-enforced on every mutation — hiding a sidebar item is never the control.
  Proven by `smoke-*` RBAC steps (teacher 403 on create/publish/staff/announce;
  cashier 403 on invoice/reverse; parent 403 on cross-child).
- **AUD-004 fixed:** the one permission gate that degraded to open on a DB error
  (attendance correction) now fails closed.

## Secrets & config

- Service-role key confined to API/workers/scripts; never in `NEXT_PUBLIC_*`.
  Verified by sweep. Only public values are exposed to the browser.
- **AUD-005 fixed:** `WEB_ORIGIN` now fails fast in production instead of
  falling back to localhost (which had leaked into invite links + CORS).
- Demo credentials are intentionally in the client bundle (public demo);
  guardrail tracked as AUD-022.

## Injection & output safety

- **SQL injection:** none possible from user input — all data access is через
  the Supabase client (parameterised) or `security definer` RPCs with typed
  args and `set search_path = public`. No string-built SQL anywhere.
- **XSS:** no `dangerouslySetInnerHTML` in the codebase. React escapes by
  default. CSV/PDF formula-injection escaping is a **requirement for the unbuilt
  reporting module** (ATLAS_REPORTING_SPEC.md §CSV).
- **Open redirects:** AUD-006 and AUD-007 fixed via `safeNext()`
  (`apps/web/src/lib/safe-redirect.ts`) — rejects absolute, `//host`,
  backslash, and control-char targets on both the login and email-confirm flows.

## Input validation

Every API mutation parses `body`/`query` through zod with tight bounds (import
≤2000 rows, scores/attendance ≤500, invoice lines ≤50, string caps). Two loose
UUID regexes produce 500s instead of 400s on malformed ids (AUD-017, cosmetic).

## Transport & headers

- CORS locked to `WEB_ORIGIN` with credentials. **Not yet added:** security
  headers (HSTS, CSP, X-Frame-Options), rate limiting (AUD-016), CSRF is N/A for
  the Bearer-token API but must be considered if cookie auth is added.

## Dependencies

- **AUD-010 fixed:** `pnpm audit --prod` → "No known vulnerabilities found"
  after pinning `xlsx@0.20.3`, `multer>=2.2.0`, `postcss>=8.5.10`.
- Run `pnpm audit --prod` in CI.

## Prompt injection (AI)

Not applicable yet — the AI assistant is unbuilt. The spec
(ATLAS_AI_ASSISTANT_SPEC.md) mandates treating uploaded document text as
untrusted and never letting it override permissions or tool scoping.

## Open security items

All P3, in the bug register: AUD-011 (typed RPC returns), AUD-013 (pagination),
AUD-016 (rate limiting + tenant-creation gating), AUD-017 (UUID validation),
AUD-018 (surface DB errors), AUD-022 (demo guardrails), AUD-023 (email
confirmation). **No P0/P1 security issues remain open.**
