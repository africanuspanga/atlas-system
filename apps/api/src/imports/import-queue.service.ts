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
 * Best-effort kick to the imports queue. The DB (import_jobs.status='queued')
 * is the source of truth — the worker also polls it — so a Redis outage
 * delays a commit but never loses it.
 */
@Injectable()
export class ImportQueueService implements OnModuleDestroy {
  private queue: Queue | null = null;

  async enqueue(
    importJobId: string,
    context: { tenantId: string; actorUserId: string },
  ): Promise<void> {
    try {
      this.queue ??= new Queue('imports', { connection: redisOptions() });
      await this.queue.add(
        'commit-import',
        { context, payload: { importJobId } },
        { jobId: importJobId, removeOnComplete: true, removeOnFail: 100 },
      );
    } catch (err) {
      logger.warn(
        { import_job_id: importJobId, err: (err as Error).message },
        'imports queue kick failed — worker poller will pick the job up',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) await this.queue.close().catch(() => {});
  }
}
