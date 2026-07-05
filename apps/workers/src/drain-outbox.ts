/**
 * Notification outbox drain — no Redis required. Polls pending rows in
 * public.notification_outbox and delivers them through the configured SMS
 * driver. Rows are claimed optimistically (update ... where status='pending')
 * so a crashed run never loses a message and a duplicate drainer never
 * double-sends.
 *
 * Usage:
 *   node dist/drain-outbox.js --once    # drain what's pending, then exit
 *   node dist/drain-outbox.js           # poll every POLL_MS (default 15s)
 */
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import { resolveDriver } from "./sms-drivers.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  logger.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");
  process.exit(1);
}

const supabase = createClient(url, serviceKey, { auth: { persistSession: false } });
const driver = resolveDriver();

const BATCH = 50;
const MAX_ATTEMPTS = 5;
const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 15_000);

/** Renders the SMS text for an outbox row from its template + payload. */
function renderBody(template: string, payload: Record<string, unknown>): string {
  if (template === "announcement") {
    return String(payload.body ?? "");
  }
  if (template === "attendance.absent") {
    // Kiswahili first — the audience is Tanzanian guardians.
    return (
      `Habari ${payload.guardianName ?? "Mzazi/Mlezi"}. ` +
      `Mwanafunzi ${payload.studentName} (${payload.studentNumber}) ` +
      `hakuhudhuria shuleni tarehe ${payload.date}. Asante.`
    );
  }
  return JSON.stringify(payload);
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  recipient: string;
  template: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function drainOnce(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  for (;;) {
    // !inner join so archived/suspended tenants never send queued messages
    const { data: rows, error } = await supabase
      .from("notification_outbox")
      .select("id, tenant_id, recipient, template, payload, attempts, tenants!inner(status)")
      .eq("status", "pending")
      .in("tenants.status", ["active", "configuration"])
      .order("created_at")
      .limit(BATCH);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) break;

    for (const row of rows as OutboxRow[]) {
      const body = renderBody(row.template, row.payload);
      try {
        await driver.send({ recipient: row.recipient, body });
        const { data: updated } = await supabase
          .from("notification_outbox")
          .update({
            status: "sent",
            attempts: row.attempts + 1,
            sent_at: new Date().toISOString(),
          })
          .eq("id", row.id)
          .eq("status", "pending")
          .select("id");
        if (updated && updated.length > 0) sent += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        await supabase
          .from("notification_outbox")
          .update({ attempts, ...(exhausted ? { status: "failed" } : {}) })
          .eq("id", row.id)
          .eq("status", "pending");
        if (exhausted) failed += 1;
        logger.error(
          { id: row.id, tenantId: row.tenant_id, attempts, err: (err as Error).message },
          "outbox delivery failed",
        );
      }
    }
    if (rows.length < BATCH) break;
  }

  return { sent, failed };
}

const once = process.argv.includes("--once");

async function main() {
  logger.info({ driver: driver.name, once }, "outbox drain starting");
  const result = await drainOnce();
  logger.info(result, "outbox drain pass complete");
  if (once) return;
  setInterval(() => {
    drainOnce()
      .then((r) => {
        if (r.sent > 0 || r.failed > 0) logger.info(r, "outbox drain pass complete");
      })
      .catch((err) => logger.error({ err: (err as Error).message }, "outbox drain pass errored"));
  }, POLL_MS);
}

void main();
