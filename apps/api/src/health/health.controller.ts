import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { RedisService } from '../observability/redis.service';

/**
 * Public health endpoints (no auth): they expose status, latency and counts
 * only — never connection strings, hostnames, keys or per-tenant data.
 *
 * Heartbeat/metric keys are written by apps/workers (see observability.ts
 * there); the names must stay in sync.
 */
const HEARTBEAT_QUEUE_WORKERS = 'atlas:heartbeat:queue-workers';
const HEARTBEAT_OUTBOX = 'atlas:heartbeat:outbox-drainer';
const METRICS_FAILED_JOBS = 'atlas:metrics:failed-jobs';

/** A heartbeat older than this is stale (workers write every 30s, TTL 90s). */
const HEARTBEAT_STALE_MS = 90_000;

@Controller('health')
export class HealthController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  overall() {
    return {
      status: 'ok',
      service: 'atlas-api',
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  @Get('database')
  async database() {
    const startedAt = Date.now();
    const { error } = await this.supabase.admin
      .from('roles')
      .select('id')
      .limit(1);
    if (error) {
      throw new ServiceUnavailableException({
        status: 'down',
        component: 'database',
      });
    }
    return {
      status: 'ok',
      component: 'database',
      latencyMs: Date.now() - startedAt,
    };
  }

  @Get('redis')
  async redis_() {
    const startedAt = Date.now();
    try {
      await this.redis.connection.ping();
    } catch {
      throw new ServiceUnavailableException({
        status: 'down',
        component: 'redis',
      });
    }
    return {
      status: 'ok',
      component: 'redis',
      latencyMs: Date.now() - startedAt,
    };
  }

  @Get('workers')
  async workers() {
    let queueWorkers: string | null = null;
    let outboxDrainer: string | null = null;
    let failedJobs: Record<string, string> = {};
    try {
      const conn = this.redis.connection;
      [queueWorkers, outboxDrainer] = await conn.mget(
        HEARTBEAT_QUEUE_WORKERS,
        HEARTBEAT_OUTBOX,
      );
      failedJobs = await conn.hgetall(METRICS_FAILED_JOBS);
    } catch {
      throw new ServiceUnavailableException({
        status: 'down',
        component: 'redis',
      });
    }
    const freshness = (iso: string | null) =>
      !iso
        ? 'missing'
        : Date.now() - new Date(iso).getTime() > HEARTBEAT_STALE_MS
          ? 'stale'
          : 'ok';
    const queueStatus = freshness(queueWorkers);
    const outboxStatus = freshness(outboxDrainer);
    return {
      status: queueStatus === 'ok' && outboxStatus === 'ok' ? 'ok' : 'degraded',
      component: 'workers',
      queueWorkers: { status: queueStatus, lastHeartbeat: queueWorkers },
      outboxDrainer: { status: outboxStatus, lastHeartbeat: outboxDrainer },
      failedJobsByQueue: Object.fromEntries(
        Object.entries(failedJobs).map(([queue, count]) => [
          queue,
          Number(count),
        ]),
      ),
    };
  }

  /** Early warning for stuck/failing SMS delivery. Counts only, no PII. */
  @Get('outbox')
  async outbox() {
    const pending = await this.supabase.admin
      .from('notification_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');
    const failed = await this.supabase.admin
      .from('notification_outbox')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed');
    if (pending.error || failed.error) {
      throw new ServiceUnavailableException({
        status: 'down',
        component: 'outbox',
      });
    }
    const { data: oldest } = await this.supabase.admin
      .from('notification_outbox')
      .select('created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const oldestPendingAgeSec = oldest
      ? Math.round(
          (Date.now() - new Date(oldest.created_at as string).getTime()) / 1000,
        )
      : 0;
    return {
      status: 'ok',
      component: 'outbox',
      pending: pending.count ?? 0,
      failed: failed.count ?? 0,
      oldestPendingAgeSec,
    };
  }
}
