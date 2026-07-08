/**
 * Import-commit worker. The DB is the source of truth: any job in status
 * 'queued' (or a stale 'committing' after a crash) gets committed in chunks
 * through the idempotent app.import_commit_chunk RPC — a row is committed at
 * most once, so re-processing after a crash cannot duplicate students or
 * invoices. BullMQ (see main.ts) only accelerates pickup; this module also
 * runs standalone:
 *
 *   node dist/process-imports.js --once   # commit everything queued, exit
 *   node dist/process-imports.js          # poll every IMPORTS_POLL_MS (15s)
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const CHUNK_ROWS = 200;
const POLL_MS = Number(process.env.IMPORTS_POLL_MS ?? 15_000);

export function createServiceClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

interface QueuedJob {
  id: string;
  tenant_id: string;
  domain: string;
  created_by: string | null;
}

/** Commits one job to completion. Safe to call twice (idempotent chunks). */
export async function processImportJob(
  supabase: SupabaseClient,
  job: QueuedJob,
): Promise<{ committed: number; failed: number }> {
  let committed = 0;
  let failed = 0;
  for (;;) {
    const { data, error } = await supabase.rpc("import_commit_chunk", {
      p_tenant_id: job.tenant_id,
      p_actor: job.created_by,
      p_job_id: job.id,
      p_max_rows: CHUNK_ROWS,
    });
    if (error) throw new Error(error.message);
    const result = data as { processed: number; committed: number; failed: number; done: boolean };
    committed += result.committed;
    failed += result.failed;
    logger.info(
      { importJobId: job.id, tenantId: job.tenant_id, ...result },
      "import chunk committed",
    );
    if (result.done) break;
  }

  await writeErrorReport(supabase, job);
  return { committed, failed };
}

/** Uploads a CSV of problem rows next to the original file (private bucket). */
async function writeErrorReport(supabase: SupabaseClient, job: QueuedJob): Promise<void> {
  const { data: problems } = await supabase
    .from("import_staging_rows")
    .select("row_number, validation_status, validation_errors, commit_error, raw_data")
    .eq("import_job_id", job.id)
    .or("validation_status.in.(invalid,warning),commit_error.not.is.null")
    .order("row_number")
    .limit(5000);
  if (!problems || problems.length === 0) return;

  // Formula-injection-safe CSV (leading = + - @ get a leading quote).
  const esc = (v: unknown): string => {
    let s = String(v ?? "");
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = ["row_number,status,errors,raw_data"];
  for (const p of problems) {
    const errors = (p.validation_errors as { code: string; message: string }[] | null) ?? [];
    const summary = [
      ...errors.map((e) => `${e.code}: ${e.message}`),
      ...(p.commit_error ? [`COMMIT: ${p.commit_error as string}`] : []),
    ].join("; ");
    lines.push(
      [p.row_number, p.validation_status, esc(summary), esc(JSON.stringify(p.raw_data))].join(","),
    );
  }
  const csv = "﻿" + lines.join("\r\n"); // BOM for Excel UTF-8

  const path = `${job.tenant_id}/${job.id}/errors.csv`;
  const { error } = await supabase.storage
    .from("imports")
    .upload(path, Buffer.from(csv, "utf8"), { contentType: "text/csv", upsert: true });
  if (error) {
    logger.error({ importJobId: job.id, err: error.message }, "error report upload failed");
    return;
  }
  await supabase.from("import_jobs").update({ error_report_path: path }).eq("id", job.id);
}

export async function drainImportsOnce(supabase: SupabaseClient): Promise<number> {
  const { data: jobs, error } = await supabase
    .from("import_jobs")
    .select("id, tenant_id, domain, created_by")
    .in("status", ["queued", "committing"])
    .order("created_at")
    .limit(10);
  if (error) throw new Error(error.message);
  let processed = 0;
  for (const job of (jobs ?? []) as QueuedJob[]) {
    try {
      const result = await processImportJob(supabase, job);
      logger.info({ importJobId: job.id, ...result }, "import job finished");
      processed += 1;
    } catch (err) {
      logger.error(
        { importJobId: job.id, err: (err as Error).message },
        "import job errored — will retry on next pass",
      );
    }
  }
  return processed;
}

// Standalone entrypoint (mirrors drain-outbox.ts).
const isMain = process.argv[1]?.endsWith("process-imports.js")
  || process.argv[1]?.endsWith("process-imports.ts");
if (isMain) {
  const once = process.argv.includes("--once");
  const supabase = createServiceClient();
  const run = () =>
    drainImportsOnce(supabase).catch((err) =>
      logger.error({ err: (err as Error).message }, "imports drain pass errored"),
    );
  void run().then(() => {
    if (once) return;
    let running = false;
    setInterval(() => {
      if (running) return;
      running = true;
      void run().finally(() => {
        running = false;
      });
    }, POLL_MS);
  });
}
