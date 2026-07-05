# ATLAS Fix Log

_Audit branch: `audit/production-readiness` · Baseline tag: `v0.1.0-pre-audit`_

Chronological record of changes made during the stabilisation pass. Every fix
ties to a bug-register ID. All changes verified by `pnpm turbo run lint
typecheck test build` (11/11 green), the 7 module smoke tests, and
`smoke-isolation.mjs`.

| Order | ID | Change | Files | Verified by |
|------:|----|--------|-------|-------------|
| 1 | AUD-010 | Pin vulnerable deps via pnpm overrides (`xlsx@0.20.3`, `multer>=2.2.0`, `postcss>=8.5.10`) | `package.json` | `pnpm audit --prod` → clean |
| 2 | — | Fix API lint (typed Supabase join casts) uncovered by gate run | `parents.controller.ts` | `pnpm --filter @atlas/api lint` |
| 3 | AUD-001 | Import RPC rejects cross-tenant `classSectionId` | `migrations/0010`, `students.controller.ts` | `smoke-isolation` step 5 |
| 4 | AUD-002 | DB triggers make payments/journal/invoice_lines immutable | `migrations/0010` | `smoke-isolation` step 7 |
| 5 | AUD-003 | Advisory lock serialises concurrent register submits | `migrations/0010` | `smoke-attendance` |
| 6 | AUD-004 | Attendance correction gate: tenant-scoped + fails closed on DB error | `attendance.controller.ts` | `smoke-attendance` step 6 |
| 7 | AUD-005 | `resolveWebOrigin()` fails fast in prod; used for CORS + invite links | `config.ts` (new), `main.ts`, `invitations.controller.ts`, `parents.controller.ts` | build + startup |
| 8 | AUD-006/007 | `safeNext()` blocks open redirects on confirm + login | `lib/safe-redirect.ts` (new), `auth/confirm/route.ts`, `login-form.tsx` | lint + manual |
| 9 | AUD-008 | Outbox claim-before-send + overlapping-pass guard (no double SMS) | `workers/drain-outbox.ts` | `smoke-communication`, `smoke-parents` drain steps |
| 10 | AUD-009 | Fix 2 hidden web-lint violations + dead `useRouter`; report-card fetch race-safe | `page.tsx`, `report-card-view.tsx`, `students-view.tsx` | `pnpm --filter @atlas/web lint` |
| 11 | — | New attack suite `smoke-isolation.mjs` (7 stages, 2 schools) | `apps/api/scripts/smoke-isolation.mjs` | run green |
| 12 | — | 11 audit documents | `docs/audit/*` | — |

## Migration added

`supabase/migrations/00000000000010_audit_hardening.sql` — pushed to live
Supabase. Contains AUD-001 (import section guard), AUD-002 (immutability
triggers), AUD-003 (advisory-lock in `mark_attendance`). Idempotent-safe on the
function replacements; the four `create trigger` statements are new objects.

## Rollback

- Code: `git checkout v0.1.0-pre-audit` (pre-audit baseline).
- DB: migration 0010 only adds triggers + hardens three functions. To roll back
  the triggers: `drop trigger payments_immutable on public.payments;` (and the
  other three) — the pre-0010 function bodies remain in migrations 0004/0005 and
  can be re-applied. No data migration, so rollback is safe.

## Not changed (deliberately)

P3 items AUD-011…AUD-023 are left open with rationale in the bug register — none
blocks a controlled pilot, and several (pagination, aggregation, rate limiting)
are better solved alongside the platform/reporting build rather than piecemeal.
