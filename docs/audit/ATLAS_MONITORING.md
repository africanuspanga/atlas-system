# ATLAS Monitoring & Alerting

_Added 2026-07-08 · Closes release-readiness item 18 for pilot scope._

## Health endpoints (public, counts/latency only — no infra details, no PII)

| Endpoint | Checks | Unhealthy response |
|---|---|---|
| `GET /api/v1/health` | API process up, uptime | (process down → no response) |
| `GET /api/v1/health/database` | Supabase reachable, query latency | 503 `{status:"down"}` |
| `GET /api/v1/health/redis` | Redis PING latency | 503 |
| `GET /api/v1/health/workers` | queue-worker + outbox-drainer heartbeats (written every 30s, TTL 90s), failed-job counts per queue | 200 `status:"degraded"` when a heartbeat is missing/stale; 503 if Redis itself is down |
| `GET /api/v1/health/outbox` | pending/failed SMS counts, oldest pending age | 503 |

Smoke: `apps/api/scripts/smoke-health.mjs`.

## Structured logs

Every API request emits one JSON line (pino) with `request_id`, `user_id`,
`tenant_id`, `method`, `route`, `status_code`, `duration_ms`, `error_code`.
The `x-request-id` response header lets the web app / support correlate a user
report to the exact log line. Bodies, tokens and secrets are never logged.
Workers already log per-job with tenant context; failed jobs also increment
`atlas:metrics:failed-jobs` (surfaced by `/health/workers`).

## Error alerting (Sentry)

`SENTRY_DSN` (already in `.env`, currently empty) activates `@sentry/node` in
the API; every 5xx is captured with `request_id` + route. With the DSN unset
the SDK is fully inert. **Ops step: create a free Sentry project and set the
DSN in production.**

## Uptime alerting (external — required before pilot go-live)

Point an uptime monitor (UptimeRobot/Better Stack/Checkly, any works) at:

- `/api/v1/health` — alert on non-200 (API down)
- `/api/v1/health/database` — alert on 503 (DB down)
- `/api/v1/health/workers` — alert when body `status != "ok"` for >5 min
  (SMS/jobs stalled)
- `/api/v1/health/outbox` — alert when `failed > 0` or
  `oldestPendingAgeSec > 900` (SMS stuck)

## What is tracked vs. deferred (CTO §17)

Covered now: API error rate + latency (logs), failed jobs, queue worker
liveness, SMS failure counts, request/tenant correlation, 5xx alerting hook.
Deferred (needs infra or the unbuilt module): slow-query/RLS-denial metrics
(Supabase dashboard provides both — link them in the ops bookmarks), payment
webhook failures (no webhook layer yet), AI cost per tenant (AI unbuilt),
subscription enforcement errors (platform layer), log aggregation (ship pino
stdout to the host's log service when deployed).
