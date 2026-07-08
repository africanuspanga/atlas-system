import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, type RedisOptions } from 'bullmq';
import { logger } from '../observability/logger';

/** BullMQ wants options, not a live ioredis client (type mismatch across
 * ioredis versions). Same URL parsing as apps/workers/src/main.ts. */
function redisOptions(): RedisOptions {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password || undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
    maxRetriesPerRequest: null,
    connectTimeout: 2000,
  };
}

/**
 * Best-effort kick to a worker queue. For every queue the DB row
 * (import_jobs / report_jobs with status='queued') is the source of truth and
 * the worker also polls it — a Redis outage delays background work but never
 * loses it.
 */
@Injectable()
export class QueueKickService implements OnModuleDestroy {
  private queues = new Map<string, Queue>();

  async kick(
    queueName: string,
    jobName: string,
    jobId: string,
    context: { tenantId: string; actorUserId: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      let queue = this.queues.get(queueName);
      if (!queue) {
        queue = new Queue(queueName, { connection: redisOptions() });
        this.queues.set(queueName, queue);
      }
      await queue.add(
        jobName,
        { context, payload },
        { jobId, removeOnComplete: true, removeOnFail: 100 },
      );
    } catch (err) {
      logger.warn(
        { queue: queueName, job_id: jobId, err: (err as Error).message },
        'queue kick failed — worker poller will pick the job up',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.queues.values()].map((q) => q.close().catch(() => {})),
    );
  }
}
