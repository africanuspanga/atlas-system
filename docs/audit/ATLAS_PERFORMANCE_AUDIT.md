# ATLAS performance audit

_Updated 3 August 2026. Pilot evidence exists; multi-school scale has not been
formally load-tested._

## Evidence

- `seed-demo.mjs` previously drove roughly 900 API calls to create 258 students,
  120 attendance registers, 3,960 scores, 258 invoices, 312 payments, 1,140
  journal lines, and communications in about two minutes with a balanced ledger.
- Twenty-five live-connected smoke suites passed on the current schema.
- The production web build generates 32 dynamic routes successfully.
- The real-provider 40-case AI run averaged 17.5 seconds and used 388,805
  tokens; the slowest broad prompt observed was roughly 56 seconds.

These are functional data points, not an SLA or capacity benchmark.

## Hardening already present

- Tenant/date/status indexes cover the primary student, attendance, finance,
  outbox, AI, report, and operational paths.
- Reads that can exceed Supabase's 1,000-row cap use deterministic pagination or
  aggregate RPCs in the audited high-volume paths.
- Imports/reports are durable background jobs; outbox and other workers claim in
  bounded batches and recover stale work.
- API bodies, import rows, tool results, report jobs, SMS size, retries, and AI
  monthly usage are bounded.
- Platform revenue uses latest subscriptions; operational overview excludes
  archived tenants and avoids counting their historical activity.

## Known performance risks

- Parent `/children` assembles several domains per child and should be measured
  for large sibling counts and post-results login bursts.
- Some dashboard/platform aggregates can grow with years of school history;
  verify query plans and statement timeouts at realistic volumes.
- Platform health performs per-tenant activity aggregates. Existing indexes
  help, but 100+ schools/millions of activity rows need `EXPLAIN ANALYZE` and
  potentially maintained summary tables.
- AI latency/cost is the main current user-facing performance concern. Track
  p50/p95 by tool/prompt, provider errors, tokens/answer, and abandonment.
- Native/web behavior on slow Tanzanian mobile data and low-memory phones has
  not completed field acceptance.
- PDF/XLSX concurrency, large imports, and outbox throughput need sustained
  worker/recovery tests with real production limits.

## Scale test required before broad onboarding

Model at least 100 schools × 2,000 students, multi-year attendance and finance,
simultaneous morning attendance, report-card release bursts, payroll month-end,
bulk reports/imports, and parent logins. Measure:

- API/DB p50/p95/p99 and error/timeout rate;
- Postgres plans, locks, pool utilization, slow queries, and RLS overhead;
- Redis/BullMQ depth, claim latency, recovery, and worker memory;
- outbox provider throughput/cost/duplicate behavior;
- web Core Web Vitals and mobile startup/list performance;
- AI latency/tokens/quota contention per tenant;
- noisy-neighbor behavior between a large and small school.

Define capacity/SLO budgets before the test. A controlled one-school pilot can
proceed after the go-live blockers, but marketing should not claim 100-school
scale or instant AI answers from the present evidence.
