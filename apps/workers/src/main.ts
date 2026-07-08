import { Worker, type Job, type RedisOptions } from "bullmq";
import pino from "pino";
import { QUEUES, type TenantJob } from "./queues.js";
import {
  HEARTBEAT_QUEUE_WORKERS,
  closeObservability,
  recordFailedJob,
  startHeartbeat,
} from "./observability.js";
import { createServiceClient, processImportJob } from "./process-imports.js";
import { processReportJob } from "./process-reports.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection: RedisOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  db: redisUrl.pathname.length > 1 ? Number(redisUrl.pathname.slice(1)) : 0,
  maxRetriesPerRequest: null,
};

function assertTenantContext(job: Job): asserts job is Job<TenantJob> {
  const data = job.data as Partial<TenantJob> | undefined;
  if (!data?.context?.tenantId) {
    throw new Error(`Job ${job.id} on ${job.queueName} is missing tenant context`);
  }
}

const supabase = createServiceClient();

/** Per-queue processors. Queues without one fail loudly (never silently). */
const processors: Partial<Record<string, (job: Job<TenantJob>) => Promise<void>>> = {
  [QUEUES.imports]: async (job) => {
    const { importJobId } = job.data.payload as { importJobId: string };
    const { data: importJob, error } = await supabase
      .from("import_jobs")
      .select("id, tenant_id, domain, created_by")
      .eq("id", importJobId)
      .eq("tenant_id", job.data.context.tenantId) // job context must match the row
      .in("status", ["queued", "committing"])
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!importJob) return; // already committed or cancelled — idempotent no-op
    const result = await processImportJob(supabase, importJob);
    logger.info({ importJobId, ...result }, "import job finished");
  },
  [QUEUES.reports]: async (job) => {
    const { reportJobId } = job.data.payload as { reportJobId: string };
    // Atomic claim so the DB poller and BullMQ can't both process it.
    const { data: claimed, error } = await supabase
      .from("report_jobs")
      .update({ status: "processing" })
      .eq("id", reportJobId)
      .eq("tenant_id", job.data.context.tenantId)
      .eq("status", "queued")
      .select("id, tenant_id, report_key, format, params, reference, requested_by");
    if (error) throw new Error(error.message);
    if (!claimed || claimed.length === 0) return; // already handled — no-op
    try {
      await processReportJob(supabase, claimed[0] as Parameters<typeof processReportJob>[1]);
    } catch (err) {
      await supabase
        .from("report_jobs")
        .update({ status: "failed", error: (err as Error).message.slice(0, 500) })
        .eq("id", reportJobId);
      throw err;
    }
  },
};

const workers = Object.values(QUEUES).map(
  (queueName) =>
    new Worker(
      queueName,
      async (job) => {
        assertTenantContext(job);
        logger.info(
          { queue: queueName, jobId: job.id, name: job.name, tenantId: job.data.context.tenantId },
          "job received",
        );
        const processor = processors[queueName];
        // Queues without a processor fail loudly instead of silently succeeding.
        if (!processor) {
          throw new Error(`No processor registered for job "${job.name}" on queue "${queueName}"`);
        }
        await processor(job);
      },
      { connection, concurrency: 5 },
    ),
);

for (const worker of workers) {
  worker.on("failed", (job, err) => {
    logger.error({ queue: worker.name, jobId: job?.id, err: err.message }, "job failed");
    recordFailedJob(worker.name);
  });
}

startHeartbeat(HEARTBEAT_QUEUE_WORKERS);
logger.info({ queues: Object.values(QUEUES) }, "ATLAS workers started");

async function shutdown() {
  logger.info("shutting down workers");
  await Promise.all(workers.map((w) => w.close()));
  await closeObservability();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
