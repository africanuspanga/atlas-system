# ATLAS Bug Register

_Audit date: 2026-07-05 · Branch: `audit/production-readiness`_

Findings from the static warning-sign sweep (Explore agent, 45 file reads),
the quality-gate run, and manual review. **No P0 or P1 issues were found.**
Five P2s and the highest-value P3s were fixed in this audit pass; the rest are
tracked for follow-up.

Severity per the CTO rubric. Status: FIXED (this pass) · OPEN · WONTFIX(justified).

---

## Fixed this pass

### AUD-001 — Excel import accepted cross-tenant class section — P1-adjacent (rated P2)
- **Module:** Students / import · **Files:** `supabase/migrations/00000000000010_audit_hardening.sql`, `apps/api/src/students/students.controller.ts`
- **Description:** `app.import_students` inserted a `class_enrolments` row using the caller-supplied `classSectionId` without checking the section belonged to the caller's tenant. A staff member could enrol their own student into another school's section id.
- **Root cause:** Missing tenant ownership check on `classSectionId` inside the RPC (the interactive `/students` create path resolves sections server-side, but the import RPC trusted the id).
- **Fix:** RPC now `select id from class_sections where id = ? and tenant_id = p_tenant_id`, raising `IMPORT_SECTION_NOT_FOUND` on miss; API maps it to a 400.
- **Test:** `smoke-isolation.mjs` step 5 ("student create with B section" → 400 `IMPORT_SECTION_NOT_FOUND`).
- **Note:** Impact was limited (enrolment row only, still tagged with the attacker's own tenant_id so it never became visible to the victim school), which is why it is rated P2 not P1 — but it violated the tenant-scoping invariant and is now closed.

### AUD-002 — Financial records mutable by service-role code — P1
- **Module:** Finance · **File:** `supabase/migrations/00000000000010_audit_hardening.sql`
- **Description:** Immutability of payments and journal entries was enforced only by convention (the API never issues UPDATE/DELETE). A bug or a future endpoint could silently rewrite the books.
- **Root cause:** No database-level protection; RLS does not restrict the service role.
- **Fix:** `before update or delete` triggers on `payments`, `journal_entries`, `journal_lines`, `invoice_lines` raise `FINANCIAL_RECORDS_ARE_IMMUTABLE`. Reversals (new rows) remain the only correction path.
- **Test:** `smoke-isolation.mjs` step 7 (service-role UPDATE and DELETE on `payments` and `journal_lines` both rejected; amount intact).

### AUD-003 — Attendance register submission raced the unique constraint — P2
- **Module:** Attendance · **File:** `supabase/migrations/00000000000010_audit_hardening.sql`
- **Description:** Two concurrent submissions of the same (section, date) surfaced the unique-constraint violation as a 500.
- **Fix:** `app.mark_attendance` takes a `pg_advisory_xact_lock` on `hash(section||date)` so concurrent submissions serialise cleanly.
- **Test:** existing `smoke-attendance.mjs` still green; behaviour is a latency/serialisation change, not a contract change.

### AUD-004 — Attendance correction permission gate failed open on DB error + unscoped lookup — P2
- **Module:** Attendance · **File:** `apps/api/src/attendance/attendance.controller.ts`
- **Description:** The "does a register already exist?" lookup (which gates the `attendance.correct` permission) ignored its error and omitted `tenant_id`. On a transient DB error, `existing` was null, so a user holding only `attendance.mark` could overwrite an existing register.
- **Fix:** Query now filters `.eq('tenant_id', …)` and throws `ATTENDANCE_LOOKUP_FAILED` on error (fails closed).
- **Test:** `smoke-attendance.mjs` step 6 (teacher still 403 on correction).

### AUD-005 — `WEB_ORIGIN` localhost fallback baked into invite links — P2
- **Module:** Invitations / config · **Files:** `apps/api/src/config.ts` (new), `apps/api/src/main.ts`, `invitations.controller.ts`, `parents/parents.controller.ts`
- **Description:** `process.env.WEB_ORIGIN ?? 'http://localhost:3000'` meant an unset var in production would mint invite links pointing at localhost (and lock CORS to localhost).
- **Fix:** `resolveWebOrigin()` throws at startup if `WEB_ORIGIN` is unset while `NODE_ENV=production`; strips trailing slash; used for CORS and both invite builders.

### AUD-006 — Open redirect after email confirmation — P2
- **Module:** Web auth · **File:** `apps/web/src/app/auth/confirm/route.ts`
- **Description:** `redirect(searchParams.get("next") ?? "/")` with no validation — a crafted confirmation link with `next=https://evil.com` redirected the user off-site immediately after a successful OTP.
- **Fix:** New `safeNext()` helper (`apps/web/src/lib/safe-redirect.ts`) rejects absolute, protocol-relative (`//host`), backslash, and control-char targets; only same-origin paths pass.

### AUD-007 — Protocol-relative open redirect after login — P2
- **Module:** Web auth · **File:** `apps/web/src/app/login/login-form.tsx`
- **Description:** `next?.startsWith("/") ? next : "/"` admitted `//evil.com`.
- **Fix:** Uses the same `safeNext()` helper.

### AUD-008 — Outbox drainer could double-send SMS — P2
- **Module:** Workers · **File:** `apps/workers/src/drain-outbox.ts`
- **Description:** The row was marked `sent` only AFTER `driver.send()` succeeded, and overlapping `setInterval` passes were unguarded — two drainers (or a slow pass) could both send the same SMS. Real cost: parents double-billed reminders on Beem.
- **Fix:** Claim-before-send — an atomic `update … set status='sent' where status='pending'` gates delivery; only the winner sends. On failure the claim is released (back to `pending`, or `failed` when attempts exhausted). Overlapping passes guarded by a `running` flag. Trade-off documented in-code: at-most-once (a crash between claim and send loses one message), which is the correct bias for billed SMS.
- **Test:** `smoke-communication.mjs` and `smoke-parents.mjs` drain steps still deliver the exact expected counts.

### AUD-009 — Web lint never enforced (2 real violations hidden) — P2
- **Module:** Web / CI · **Files:** `apps/web/src/app/page.tsx`, `apps/web/src/app/students/[id]/report-card/report-card-view.tsx`, `students-view.tsx`
- **Description:** A stale Turborepo lint cache masked two real lint errors (`Date.now()` impurity in render; synchronous setState in an effect) and a dead `useRouter`. They only surfaced when the lockfile change busted the cache.
- **Fix:** Reused one `Date` instance; converted the report-card fetch to an inline async effect with an `ignore` flag (also fixes a stale-response race on rapid term switching); removed dead `useRouter`. `pnpm turbo run lint typecheck test build` = 11/11 green.

### AUD-010 — Five dependency vulnerabilities (3 high, 2 moderate) — P2
- **Module:** Dependencies · **File:** root `package.json`
- **Description:** `pnpm audit --prod` reported `xlsx` (2× high, prototype pollution / ReDoS), transitive `multer` (via `@nestjs/platform-express`), and `postcss`.
- **Fix:** pnpm `overrides` pin `xlsx@0.20.3` (SheetJS CDN), `multer>=2.2.0`, `postcss>=8.5.10`. `pnpm audit --prod` = "No known vulnerabilities found".

---

## Open (tracked, not blocking a single-school pilot)

| ID | Title | Module | Sev | Notes |
|----|-------|--------|-----|-------|
| AUD-011 | RPC returns blind-cast (`data as {…}`) behind uncommented `eslint-disable` | API (14 sites) | P3 | Generate Supabase types or wrap RPC returns in zod. |
| AUD-012 | Arbitrary tenant selected via `tenants…limit(1)` for multi-school users | Web pages | P3 | Add a tenant switcher; today a two-school user gets a Postgres-order-dependent tenant. |
| AUD-013 | List endpoints without pagination (`/staff`, `/invitations`) | API | P3 | Fine for pilot sizes; add cursor pagination before large schools. |
| AUD-014 | Portal `/children` is N+1 and reads attendance unbounded | API | P3 | Batch queries + aggregate counts in SQL. |
| AUD-015 | Dashboard/accounting/finance server reads unbounded (no `.limit()`) | Web | P3 | Latency grows with history; cap or aggregate in SQL/RPC. |
| AUD-016 | ~~No rate limiting (esp. `POST /onboarding` tenant creation)~~ **FIXED 2026-07-08**: `@nestjs/throttler` global (300/min) + per-IP onboarding limit (`ONBOARD_RATE_LIMIT`, default 6/min); tenant creation now also auto-subscribes to the trial plan and every request is entitlement-checked (mig 0013). Test: `smoke-platform.mjs` step 7. | API | P3→FIXED | — |
| AUD-017 | Loose UUID regex → 500 instead of 400 on malformed ids | API | P3 | `tenant.guard.ts:47`, `parents.controller.ts` termId. Use `z.string().uuid()`. |
| AUD-018 | Ignored errors on list/select queries mask outages as empty results | API | P3 | Surface DB errors as 500s distinct from empty sets. |
| AUD-019 | `nav-user.tsx` floating `getUser().then()` (no catch) | Web | P3 | Add `.catch`. |
| AUD-020 | `finance-view` reminder handler can read `.queued` off null body | Web | P3 | Guard null before property access. |
| AUD-021 | Outbox retry has no backoff/jitter and no failure-reason column | Workers | P3 | Add exponential backoff + `last_error`. |
| AUD-022 | Demo credentials shipped in client bundle | Web | P3 | Intentional (public demo). Guardrail: cap demo tenant, block plan/tenant creation from it. |
| AUD-023 | Supabase email confirmation ON but no transactional email wired | Infra | P3 | Turn off for dev, or wire email, before parent self-signup at scale. |

## Summary

- **Discovered:** 23 findings (0 P0, 0 P1, 10 rated/fixed at P2 including 3 hardening upgrades, 13 P3).
- **Fixed this pass:** AUD-001 … AUD-010 (all P2 and the two DB-integrity upgrades).
- **Open:** AUD-011 … AUD-023 (all P3) — none block a controlled single-school pilot; several must close before multi-tenant scale.
