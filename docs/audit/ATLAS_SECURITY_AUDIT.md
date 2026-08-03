# ATLAS security audit

_Current review: 3 August 2026 · migration `0033`._

## Verdict

No known code-level P0/P1 remained after the audited migration and test pass.
Tenant isolation, platform-role escalation, financial integrity, and AI action
boundaries passed adversarial tests. Production is still blocked on deployment
secrets/monitoring, current restore evidence, SMS-provider verification, and
Tanzania privacy/cross-border processing sign-off.

## Authentication and sessions

- Supabase Auth access tokens are validated with `auth.getUser`; an auth
  provider outage is not misreported as invalid credentials.
- Active school membership is checked on every tenant API request. Revoked,
  suspended, and archived access fails closed.
- Multi-school selection uses a validated HTTP-only tenant cookie in web; the
  API still validates `x-tenant-id` independently.
- Native mobile sessions use chunked `expo-secure-store`; legacy plaintext
  AsyncStorage sessions migrate once and are removed. Browser storage remains
  browser-appropriate AsyncStorage/cookies.
- Invite links are single-use/expiring; redirect targets are restricted to
  same-origin paths.

Production must verify email delivery/confirmation and account recovery; no
documentation should treat development/demo credentials as customer accounts.

## Authorization and tenant isolation

- `AuthGuard → TenantGuard → @RequirePermission` protects tenant endpoints.
- Service-role queries use the server-resolved tenant and fail closed on lookup
  errors. RLS protects direct browser/PostgREST reads.
- Permission-aware RLS limits teachers/class teachers; parents see only their
  own guardian record and linked children rather than broad school membership.
- `profiles.platform_role` cannot be updated by anon/authenticated users.
  Platform access has a separate guard and append-only platform audit trail.
- Tenant ownership triggers block cross-school links even under service-role
  code.

Live JWT attacks passed for linked parent, pure teacher, finance user, and
platform self-escalation. The full shadow found no unintended RLS table with no
policy. See `ATLAS_TENANT_ISOLATION_AUDIT.md`.

## Input, injection, and browser controls

- Mutating API bodies/queries use bounded Zod schemas, real calendar dates,
  money precision/rate bounds, and cross-tenant ownership checks.
- Supabase parameterization/typed RPC arguments prevent string-built SQL. Every
  security-definer function uses a controlled `search_path` and narrow wrapper
  grants.
- React escaping is used; no application requirement depends on raw HTML.
- CSV/NECTA/report exports neutralize spreadsheet formulas.
- Helmet supplies API security headers; CORS is exactly `WEB_ORIGIN` and fails
  startup when missing in production.
- Global/per-onboarding throttles exist; `TRUST_PROXY` must equal the deployed
  proxy-hop count. Multiple API replicas need shared rate-limit storage before
  public self-service scale.

## Financial and payroll security

- Payments carry tenant-scoped idempotency keys; exact retries return the same
  receipt and changed retries fail.
- Future/pre-invoice payment dates fail; event and journal dates align to the
  Tanzania calendar.
- Payment, invoice-line, journal, and journal-line records are immutable at the
  database layer. Corrections are reversal rows and all journals balance.
- Payroll cannot run on unverified rates; rate changes invalidate verification;
  invalid net pay fails; wage and employer-contribution journals are separate
  and balanced.
- Payroll tables are API-only and individual salary data is not exposed through
  the AI catalogue.

## AI security

- Production rejects the deterministic mock driver and missing provider key.
- The model cannot choose tenant ids, query SQL, hold credentials, or reach the
  action-confirmation endpoint.
- Each tool checks server-derived tenant, user, permissions, arguments, and DB
  errors. Results are bounded; clinical results are de-identified and payroll
  is aggregate-only.
- Actions are user-bound, expiring proposals; confirmation rechecks permission
  and current live data before the normal RPC executes.
- Real-provider evaluation passed 40/40, including unauthorized requests,
  cross-tenant prompts, direct/data-embedded injection, Kiswahili, and attempts
  to self-confirm writes.

This does not replace privacy approval. Student identity, attendance, finance,
and health information sent to an external model requires a documented lawful
basis, minimization, DPA/processor terms, retention policy, and any required
cross-border authorization.

## Secrets, dependencies, and operations

- Service-role/database/Moonshot/Beem credentials belong only in API/workers or
  the deployment secret manager. Only anon/public URLs/keys may use
  `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*`.
- Dependency audit reported no known moderate-or-higher vulnerability after
  Next and transitive package hardening.
- Structured logs redact tokens/bodies; SMS console logs only destination
  suffix/length. `SENTRY_DSN` and `HEALTH_TOKEN` remain required production
  settings.
- SMS claims/retries/caps are hardened, but an external provider success
  followed by DB failure can cause an at-least-once duplicate on retry. Use
  provider ids/status reconciliation when available.

## Outstanding security/operational actions

1. Deploy through an approved secret manager; rotate anything previously
   shared or logged; verify no server secret reaches web/mobile artifacts.
2. Enable Sentry, protected health checks, log retention/access control, and
   alerts; test incident paging.
3. Complete a migration-33 full restore and confirm Supabase backup/PITR.
4. Complete `TANZANIA_PRIVACY_CHECKLIST.md`, including PDPC/DPA/privacy,
   cross-border AI, retention, rights, and breach-response sign-off.
5. Test Beem sender identity, delivery callbacks/status, duplicate handling,
   and opt-out/notice rules.
6. Expand automated unit/browser/load tests and rerun isolation/AI attacks on
   every permission, migration, prompt, or model change.
