# ATLAS Performance Audit

_Audit date: 2026-07-05 · Load evidence: `apps/api/scripts/seed-demo.mjs`_

## Load exercise performed

`seed-demo.mjs` drove ~900 real API calls to build "Chief Sarwatt School": 258
students, 120 attendance registers, 16 published exams (3,960 scores), 258
invoices, 312 payments, 1,140 journal lines, announcements, reminders. It
completed in ~2 minutes with the ledger balanced (TZS 422M) and all
verification checks passing. This exercised every module's write path under
volume without errors — a useful first datapoint, not a formal benchmark.

## Indexing review (migrations 0001–0010)

Existing indexes are reasonable and tenant-aware. Present, e.g.:
`students(tenant_id,status)`, `students(tenant_id,last_name,first_name)`,
`class_enrolments(tenant_id)` + `(class_section_id)`,
`attendance_sessions(tenant_id,session_date)`,
`attendance_records(student_id,status)`,
`assessment_scores(tenant_id)` + `(student_id)`,
`invoices(tenant_id,status)` + `(student_id)`, `payments(tenant_id)` +
`(invoice_id)`, `journal_lines(entry_id)` + `(account_id)`,
`notification_outbox(status,created_at) where status='pending'`.

**Gaps to add when query plans justify (do not add blindly):**
- `payments(tenant_id, created_at)` — dashboard "recent payments" orders by
  created_at within a tenant.
- `attendance_records(session_id)` — used by report-card + dashboard aggregation
  (currently reachable via student index only).
- `invoices(tenant_id, academic_term_id)` — statement/reminder queries.
- Composite `(tenant_id, status)` already exists where it matters.

## Known performance risks (all P3, bug register)

- **AUD-014** `/portal/children` is N+1 (6 queries per child) and reads
  attendance unbounded to count statuses. Batch + aggregate in SQL/RPC.
- **AUD-015** dashboard (`app/page.tsx`), `/accounting`, `/finance`,
  `/communication` server components read `payments`/`invoices`/`journal_lines`/
  `notification_outbox` with **no `.limit()`**. Latency grows linearly with
  school history. Fix: push aggregation into SQL/RPC (e.g. a
  `dashboard_summary(tenant_id, from, to)` function returning counts + sums)
  rather than fetching all rows into Node.
- **AUD-013** `/staff`, `/invitations` unpaginated.

## Not yet measured (needed before scale sign-off)

Per CTO §18, realistic multi-school volumes (100 schools × 2,000 students,
millions of attendance/journal rows, thundering-herd parent logins after
results publication, bulk report-card generation). These require a staging load
harness and `EXPLAIN ANALYZE` on the hot queries — deferred until the reporting
and dashboard aggregation refactors land, since those change the query shapes.

## Verdict

No performance blocker for a single pilot school at the demonstrated volume.
Before multi-tenant scale: convert unbounded dashboard/portal reads to SQL
aggregates, add the four indexes above once plans confirm, and run a formal load
test.
