/**
 * Smoke test: public health endpoints + request-id correlation header.
 * Requires the API running (and Redis for /health/redis to be 'ok').
 * Run: set -a && source .env && set +a && node apps/api/scripts/smoke-health.mjs
 */
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function get(path) {
  const res = await fetch(`${apiUrl}/api/v1${path}`);
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
}

// 1. Overall health + x-request-id echo
const overall = await get('/health');
if (overall.status !== 200 || overall.body.status !== 'ok') {
  throw new Error(`health: ${overall.status} ${JSON.stringify(overall.body)}`);
}
if (!overall.headers.get('x-request-id')) throw new Error('missing x-request-id header');
console.log('1. /health ok, x-request-id present');

// 2. Database
const db = await get('/health/database');
if (db.status !== 200 || db.body.status !== 'ok' || typeof db.body.latencyMs !== 'number') {
  throw new Error(`database: ${db.status} ${JSON.stringify(db.body)}`);
}
console.log(`2. /health/database ok (${db.body.latencyMs}ms)`);

// 3. Redis
const redis = await get('/health/redis');
if (redis.status !== 200 || redis.body.status !== 'ok') {
  throw new Error(`redis: ${redis.status} ${JSON.stringify(redis.body)}`);
}
console.log(`3. /health/redis ok (${redis.body.latencyMs}ms)`);

// 4. Workers heartbeat report (ok or degraded are both valid shapes; the
//    endpoint itself must respond — 'degraded' means heartbeats are missing,
//    which is expected when workers aren't running during the smoke).
const workers = await get('/health/workers');
if (workers.status !== 200 || !['ok', 'degraded'].includes(workers.body.status)) {
  throw new Error(`workers: ${workers.status} ${JSON.stringify(workers.body)}`);
}
if (!workers.body.queueWorkers || !workers.body.outboxDrainer) {
  throw new Error(`workers shape: ${JSON.stringify(workers.body)}`);
}
console.log(
  `4. /health/workers ${workers.body.status} (queue: ${workers.body.queueWorkers.status}, outbox: ${workers.body.outboxDrainer.status})`,
);

// 5. Outbox counts (no PII — counts only)
const outbox = await get('/health/outbox');
if (
  outbox.status !== 200 ||
  outbox.body.status !== 'ok' ||
  typeof outbox.body.pending !== 'number' ||
  typeof outbox.body.failed !== 'number'
) {
  throw new Error(`outbox: ${outbox.status} ${JSON.stringify(outbox.body)}`);
}
for (const key of Object.keys(outbox.body)) {
  if (['status', 'component', 'pending', 'failed', 'oldestPendingAgeSec'].includes(key)) continue;
  throw new Error(`outbox leaks unexpected field: ${key}`);
}
console.log(`5. /health/outbox ok (pending: ${outbox.body.pending}, failed: ${outbox.body.failed})`);

console.log('\nSMOKE TEST PASSED');
