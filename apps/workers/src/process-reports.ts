/**
 * Report-generation worker. Claims queued report_jobs atomically
 * (queued→processing conditional update), calls the ledger-reconciled
 * report_* SQL function, formats the file (PDF/CSV/XLSX) and stores it in the
 * private 'reports' bucket. Failure paths mark the job failed with the error
 * (REPORT_RECONCILE_FAILED surfaces to the user — a report that doesn't tie
 * to the journal is never delivered).
 *
 *   node dist/process-reports.js --once   # drain queued reports, exit
 *   node dist/process-reports.js          # poll every REPORTS_POLL_MS (10s)
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import pino from "pino";
import { createServiceClient } from "./process-imports.js";
import {
  formatTZS,
  toCsv,
  toPdf,
  toXlsx,
  type ReportColumn,
  type ReportLayout,
} from "./report-formats.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const POLL_MS = Number(process.env.REPORTS_POLL_MS ?? 10_000);

interface ReportJob {
  id: string;
  tenant_id: string;
  report_key: string;
  format: "pdf" | "csv" | "xlsx";
  params: Record<string, string>;
  reference: string;
  requested_by: string | null;
}

interface RpcPayload {
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
  generatedAt: string;
  student?: { studentNumber: string; name: string };
  filters?: Record<string, unknown>;
}

const num = (v: unknown) => Number(v ?? 0);

interface ReportDef {
  title: string;
  rpc: string;
  rpcArgs: (job: ReportJob) => Record<string, unknown>;
  columns: ReportColumn[];
  metadata: (job: ReportJob, data: RpcPayload) => Array<[string, string]>;
  totals: (data: RpcPayload) => Array<[string, string]>;
  confidential?: boolean;
}

const REPORT_DEFS: Record<string, ReportDef> = {
  fee_collection: {
    title: "Fee Collection Report",
    rpc: "report_fee_collection",
    rpcArgs: (job) => ({
      p_tenant_id: job.tenant_id,
      p_from: job.params.from,
      p_to: job.params.to,
    }),
    columns: [
      { key: "receiptNumber", label: "Receipt", weight: 1 },
      { key: "paidOn", label: "Date", weight: 1 },
      { key: "studentNumber", label: "Student No", weight: 1 },
      { key: "studentName", label: "Student", weight: 2 },
      { key: "invoiceNumber", label: "Invoice", weight: 1 },
      { key: "method", label: "Method", weight: 1 },
      { key: "amount", label: "Amount", weight: 1.2, align: "right", money: true },
    ],
    metadata: (job) => [["Period", `${job.params.from} to ${job.params.to}`]],
    totals: (data) => [
      ["Total collected", formatTZS(data.totals.total)],
      ...Object.entries((data.totals.byMethod as Record<string, unknown>) ?? {}).map(
        ([method, amount]): [string, string] => [`  via ${method}`, formatTZS(amount)],
      ),
    ],
    confidential: true,
  },
  outstanding_balances: {
    title: "Outstanding Fee Balances",
    rpc: "report_outstanding_balances",
    rpcArgs: (job) => ({ p_tenant_id: job.tenant_id }),
    columns: [
      { key: "studentNumber", label: "Student No", weight: 1 },
      { key: "studentName", label: "Student", weight: 2 },
      { key: "className", label: "Class", weight: 1.2 },
      { key: "invoiced", label: "Invoiced", weight: 1.2, align: "right", money: true },
      { key: "paid", label: "Paid", weight: 1.2, align: "right", money: true },
      { key: "balance", label: "Balance", weight: 1.2, align: "right", money: true },
    ],
    metadata: () => [["Scope", "All students with a balance"]],
    totals: (data) => [
      ["Total outstanding", formatTZS(data.totals.outstanding)],
      ["Ledger A/R (reconciled)", formatTZS(data.totals.ledgerAR)],
    ],
    confidential: true,
  },
  trial_balance: {
    title: "Trial Balance",
    rpc: "report_trial_balance",
    rpcArgs: (job) => ({ p_tenant_id: job.tenant_id }),
    columns: [
      { key: "code", label: "Code", weight: 0.7 },
      { key: "name", label: "Account", weight: 2 },
      { key: "type", label: "Type", weight: 1 },
      { key: "debits", label: "Debits", weight: 1.3, align: "right", money: true },
      { key: "credits", label: "Credits", weight: 1.3, align: "right", money: true },
      { key: "balance", label: "Balance", weight: 1.3, align: "right", money: true },
    ],
    metadata: () => [["Scope", "All journal entries to date"]],
    totals: (data) => [
      ["Total debits", formatTZS(data.totals.debits)],
      ["Total credits", formatTZS(data.totals.credits)],
    ],
    confidential: true,
  },
  student_statement: {
    title: "Student Fee Statement",
    rpc: "report_student_statement",
    rpcArgs: (job) => ({ p_tenant_id: job.tenant_id, p_student_id: job.params.studentId }),
    columns: [
      { key: "date", label: "Date", weight: 1 },
      { key: "kind", label: "Type", weight: 1 },
      { key: "reference", label: "Reference", weight: 1.2 },
      { key: "charge", label: "Charges", weight: 1.2, align: "right", money: true },
      { key: "credit", label: "Payments", weight: 1.2, align: "right", money: true },
      { key: "balance", label: "Balance", weight: 1.2, align: "right", money: true },
    ],
    metadata: (_job, data) => [
      ["Student", `${data.student?.name ?? ""} (${data.student?.studentNumber ?? ""})`],
    ],
    totals: (data) => [["Closing balance", formatTZS(data.totals.closingBalance)]],
    confidential: true,
  },
  report_card: {
    title: "Student Report Card",
    rpc: "report_card",
    rpcArgs: (job) => ({
      p_tenant_id: job.tenant_id,
      p_student_id: job.params.studentId,
      p_term_id: job.params.termId,
    }),
    columns: [
      { key: "code", label: "Code", weight: 0.8 },
      { key: "name", label: "Subject", weight: 2.4 },
      { key: "marks", label: "Marks", weight: 1, align: "right" },
      { key: "grade", label: "Grade", weight: 0.8, align: "right" },
      { key: "points", label: "Points", weight: 0.8, align: "right" },
    ],
    // report_card() returns: student{name,number}, section, term{name},
    // subjects[], average, points, division, position, classSize (mig 0006).
    metadata: (_job, data) => {
      const d = data as unknown as {
        student?: { name?: string; number?: string };
        section?: string;
        term?: { name?: string };
      };
      return [
        ["Student", `${d.student?.name ?? ""} (${d.student?.number ?? ""})`],
        ["Class", d.section ?? "—"],
        ["Term", d.term?.name ?? "—"],
      ];
    },
    totals: (data) => {
      const d = data as unknown as Record<string, unknown>;
      return [
        ["Average", String(d.average ?? "—")],
        ["Division", `${String(d.division ?? "—")} (${String(d.points ?? "—")} points)`],
        ["Position", `${String(d.position ?? "—")} of ${String(d.classSize ?? "—")}`],
      ];
    },
  },
};

export async function processReportJob(supabase: SupabaseClient, job: ReportJob): Promise<void> {
  const def = REPORT_DEFS[job.report_key];
  if (!def) throw new Error(`Unknown report key ${job.report_key}`);

  const { data, error } = await supabase.rpc(def.rpc, def.rpcArgs(job));
  if (error) throw new Error(error.message);
  const payload = data as RpcPayload;
  // report_card returns {subjects: …} instead of {rows: …}.
  const rows =
    payload.rows ??
    ((payload as unknown as { subjects?: Record<string, unknown>[] }).subjects ?? []);

  const [{ data: tenant }, { data: requester }] = await Promise.all([
    supabase.from("tenants").select("name").eq("id", job.tenant_id).single(),
    job.requested_by
      ? supabase.from("profiles").select("full_name").eq("id", job.requested_by).single()
      : Promise.resolve({ data: null }),
  ]);

  const layout: ReportLayout = {
    title: def.title,
    schoolName: (tenant?.name as string) ?? "ATLAS school",
    reference: job.reference,
    generatedBy: (requester?.full_name as string) ?? "system",
    generatedAt: new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
    metadata: def.metadata(job, payload),
    columns: def.columns,
    rows,
    totals: def.totals(payload),
    confidential: def.confidential,
  };

  const file =
    job.format === "csv" ? toCsv(layout) : job.format === "xlsx" ? toXlsx(layout) : await toPdf(layout);
  const contentType =
    job.format === "csv"
      ? "text/csv"
      : job.format === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/pdf";

  const path = `${job.tenant_id}/${job.id}/${job.reference}.${job.format}`;
  const { error: uploadError } = await supabase.storage
    .from("reports")
    .upload(path, file, { contentType, upsert: true });
  if (uploadError) throw new Error(uploadError.message);

  await supabase
    .from("report_jobs")
    .update({
      status: "completed",
      file_path: path,
      totals: payload.totals ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", job.id);
}

export async function drainReportsOnce(supabase: SupabaseClient): Promise<number> {
  let processed = 0;
  for (;;) {
    const { data: jobs, error } = await supabase
      .from("report_jobs")
      .select("id, tenant_id, report_key, format, params, reference, requested_by")
      .eq("status", "queued")
      .order("created_at")
      .limit(5);
    if (error) throw new Error(error.message);
    if (!jobs || jobs.length === 0) break;

    for (const job of jobs as ReportJob[]) {
      // Atomic claim — only the winner processes (mirrors the outbox drainer).
      const { data: claimed } = await supabase
        .from("report_jobs")
        .update({ status: "processing" })
        .eq("id", job.id)
        .eq("status", "queued")
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      try {
        await processReportJob(supabase, job);
        logger.info({ reportJobId: job.id, key: job.report_key, format: job.format }, "report generated");
        processed += 1;
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        await supabase
          .from("report_jobs")
          .update({ status: "failed", error: message })
          .eq("id", job.id);
        logger.error({ reportJobId: job.id, err: message }, "report failed");
      }
    }
    if (jobs.length < 5) break;
  }
  return processed;
}

// Standalone entrypoint (mirrors drain-outbox.ts / process-imports.ts).
const isMain = process.argv[1]?.endsWith("process-reports.js")
  || process.argv[1]?.endsWith("process-reports.ts");
if (isMain) {
  const once = process.argv.includes("--once");
  const supabase = createServiceClient();
  const run = () =>
    drainReportsOnce(supabase).catch((err) =>
      logger.error({ err: (err as Error).message }, "reports drain pass errored"),
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
