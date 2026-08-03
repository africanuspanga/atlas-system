# ATLAS monitoring and alerting

_Updated 3 August 2026. Code exists; production configuration is still a
go-live blocker._

## Health endpoints

| Endpoint                      | Purpose                                                | Expected behavior                                            |
| ----------------------------- | ------------------------------------------------------ | ------------------------------------------------------------ |
| `GET /api/v1/health`          | public process liveness/uptime                         | 200 while API is alive                                       |
| `GET /api/v1/health/database` | Supabase reachability and latency                      | 503 when unavailable                                         |
| `GET /api/v1/health/redis`    | Redis PING and latency                                 | 503 when unavailable                                         |
| `GET /api/v1/health/workers`  | queue-worker/outbox heartbeats and failed-job counters | degraded for stale/missing heartbeat; 503 when Redis is down |
| `GET /api/v1/health/outbox`   | pending/failed SMS and oldest pending age              | 503 when unhealthy                                           |

`/health` remains public for the load balancer. Set a strong `HEALTH_TOKEN` in
production; every detailed route then requires
`Authorization: Bearer <token>`. Never put the token in a browser bundle.

Workers write heartbeats every 30 seconds with a 90-second TTL. Production must
run both persistent processes:

```bash
pnpm --filter @atlas/workers start
pnpm --filter @atlas/workers drain
```

The 3 August local check correctly reported worker health as degraded because
neither persistent worker was deployed. This is an infrastructure blocker, not
a reason to weaken the check.

## Logs and errors

Every API request emits structured JSON containing `request_id`, `user_id`,
`tenant_id`, method, route, status, duration, and stable error code. Tokens,
request bodies, secrets, student clinical text, and SMS bodies must never be
logged. The response `x-request-id` correlates a user report with API logs.

Set `SENTRY_DSN` for API/worker exceptions. Current local/linked configuration
has no DSN; production cannot be signed off until a test 5xx reaches the right
Sentry project and pages the assigned responder.

## Required alerts

- API liveness non-200 for two consecutive checks.
- Database/Redis 503 or sustained latency above the agreed baseline.
- Worker status not `ok` for more than five minutes.
- Any failed outbox row; oldest eligible pending row older than 15 minutes.
- Import/report job failed or processing beyond its recovery threshold.
- 5xx rate/latency increase by route and tenant.
- AI error rate, p50/p95 latency, requests/tokens per tenant, and quota rejects.
- SMS attempted/sent/failed and cost per tenant/plan; provider reconciliation.
- Subscription/payment/lifecycle administrative failures.
- Backup/PITR failure and restore-test overdue.

Route alerts to named primary/backup responders. Test notification delivery and
acknowledgement before pilot, not only the dashboard view.

## Dashboards

The platform control centre already provides current-tenant pipeline, latest
subscription/MRR, school health, and per-tenant SMS/AI unit costs. Archived
tenants are excluded from operational totals. Infrastructure dashboards should
add API/DB/Redis/worker/Sentry/provider data rather than duplicating school PII.

## Incident minimums

Use `ATLAS_INCIDENT_RESPONSE.md` for the complete command, containment,
privacy-decision, recovery, and review flow.

1. Capture start time, environment, request ID, affected tenant/module, and
   current data-integrity state.
2. For cross-tenant exposure, financial mismatch, unauthorized platform action,
   or lost data, treat as P0: suspend affected access/sends, preserve evidence,
   and invoke the breach/incident owner.
3. Never repair finance by editing immutable rows. Use reviewed reversals or a
   forward database fix.
4. Record resolution, customer communication, root cause, verification, and
   prevention in the incident log.

Smoke coverage: `apps/api/scripts/smoke-health.mjs`. Run it in staging with
workers both healthy and intentionally stopped so alert behavior is proven.
