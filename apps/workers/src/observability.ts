/**
 * Worker heartbeats + failure metrics, read by the API's public /health
 * endpoints (apps/api/src/health/health.controller.ts — key names must stay
 * in sync). Redis is best-effort here: a metrics outage must never take the
 * workers down.
 */
import Redis from "ioredis";

export const HEARTBEAT_QUEUE_WORKERS = "atlas:heartbeat:queue-workers";
export const HEARTBEAT_OUTBOX = "atlas:heartbeat:outbox-drainer";
export const METRICS_FAILED_JOBS = "atlas:metrics:failed-jobs";

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TTL_SEC = 90;

let client: Redis | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Offline queue ON: the first command after lazyConnect must wait
      // for the connection instead of being rejected instantly.
      connectTimeout: 2000,
    });
    client.on("error", () => {}); // logged via health, not per-tick
  }
  return client;
}

/** Writes `key` now and then every 30s; TTL 90s so a dead process goes stale. */
export function startHeartbeat(key: string): NodeJS.Timeout {
  const beat = () => {
    redis()
      .set(key, new Date().toISOString(), "EX", HEARTBEAT_TTL_SEC)
      .catch(() => {});
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

export function recordFailedJob(queueName: string): void {
  redis()
    .hincrby(METRICS_FAILED_JOBS, queueName, 1)
    .catch(() => {});
}

export async function closeObservability(): Promise<void> {
  if (client) await client.quit().catch(() => {});
}
