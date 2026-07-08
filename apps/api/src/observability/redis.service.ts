import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Shared Redis connection for health checks and (later) queue producers.
 * Lazy-connects so an unreachable Redis degrades the /health/redis and
 * /health/workers endpoints instead of blocking API startup.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null;

  get connection(): Redis {
    if (!this.client) {
      this.client = new Redis(
        process.env.REDIS_URL ?? 'redis://localhost:6379',
        {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          // Offline queue ON: the first command after lazyConnect must wait
          // for the connection instead of being rejected instantly.
          connectTimeout: 2000,
        },
      );
      // Without a listener ioredis re-throws connection errors as uncaught.
      this.client.on('error', () => {});
    }
    return this.client;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) await this.client.quit().catch(() => {});
  }
}
