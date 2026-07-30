/**
 * Notification outbox drain — no Redis required. Polls pending rows in
 * public.notification_outbox and delivers them through the configured SMS
 * driver. Rows are claimed atomically (update ... where status='pending') so a
 * duplicate drainer never double-sends. Delivery is AT-MOST-ONCE: the claim
 * flips pending→sent BEFORE the driver call, so a crash between claim and send
 * can lose that one message. This is deliberate — for SMS a duplicate charge is
 * worse than a rare miss.
 *
 * Usage:
 *   node dist/drain-outbox.js --once    # drain what's pending, then exit
 *   node dist/drain-outbox.js           # poll every POLL_MS (default 15s)
 */
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import { resolveDriver } from "./sms-drivers.js";
import { HEARTBEAT_OUTBOX, startHeartbeat } from "./observability.js";

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
  if (template === "clinic.visit") {
    // Kiswahili first — queued by app.record_clinic_visit (migration 0023).
    const treatment =
      typeof payload.treatment === "string" && payload.treatment.trim() !== ""
        ? ` Matibabu: ${payload.treatment}.`
        : "";
    return (
      `Mpendwa ${payload.guardianName ?? "Mzazi/Mlezi"}. ` +
      `Mwanafunzi ${payload.studentName} (${payload.studentNumber}) ` +
      `alihudumiwa katika zahanati ya shule leo.${treatment} ` +
      `Asante. - ${payload.schoolName ?? "Shule"}`
    );
  }
  if (template === "fees.reminder") {
    const due = payload.dueOn ? ` kabla ya tarehe ${payload.dueOn}` : "";
    return (
      `Habari ${payload.guardianName ?? "Mzazi/Mlezi"}. ` +
      `Salio la ada kwa ${payload.studentName} (${payload.studentNumber}) ` +
      `ni TZS ${Number(payload.balance ?? 0).toLocaleString("en-US")} ` +
      `(ankara ${payload.invoiceNumber}). Tafadhali lipa${due}. Asante.`
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
    // !inner join so draft/suspended/archived tenants never send queued
    // messages; next_attempt_at gate skips rows still in backoff.
    const { data: rows, error } = await supabase
      .from("notification_outbox")
      .select("id, tenant_id, recipient, template, payload, attempts, tenants!inner(status)")
      .eq("status", "pending")
      .in("tenants.status", ["configuration", "data_review", "training", "live"])
      .lte("next_attempt_at", new Date().toISOString())
      .order("created_at")
      .limit(BATCH);
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) break;

    // Track successes in this batch: if a full provider outage means zero rows
    // delivered, break out and let the POLL_MS cadence back us off rather than
    // spinning tightly through claimed-then-failed rows.
    let batchSent = 0;
    for (const row of rows as OutboxRow[]) {
      // Claim the row BEFORE sending: only the drainer whose conditional
      // update actually flips pending→sent proceeds to deliver. A second
      // drainer (or an overlapping pass) gets zero rows back and skips it,
      // so a message is never billed twice. Trade-off: a crash between claim
      // and send loses that one message (at-most-once) — acceptable for SMS,
      // where a duplicate charge is worse than a rare miss.
      const { data: claimed } = await supabase
        .from("notification_outbox")
        .update({
          status: "sent",
          attempts: row.attempts + 1,
          sent_at: new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("status", "pending")
        .select("id");
      if (!claimed || claimed.length === 0) continue; // another drainer won it

      const body = renderBody(row.template, row.payload);
      try {
        await driver.send({ recipient: row.recipient, body });
        sent += 1;
        batchSent += 1;
      } catch (err) {
        const attempts = row.attempts + 1;
        const exhausted = attempts >= MAX_ATTEMPTS;
        // Release the claim: back to pending for another attempt (with an
        // exponential backoff on next_attempt_at, capped at 60 min), or failed.
        await supabase
          .from("notification_outbox")
          .update({
            status: exhausted ? "failed" : "pending",
            sent_at: null,
            ...(exhausted
              ? {}
              : {
                  next_attempt_at: new Date(
                    Date.now() + Math.min(2 ** attempts, 60) * 60_000,
                  ).toISOString(),
                }),
          })
          .eq("id", row.id);
        if (exhausted) failed += 1;
        logger.error(
          { id: row.id, tenantId: row.tenant_id, attempts, err: (err as Error).message },
          "outbox delivery failed",
        );
      }
    }
    // A batch that delivered nothing means the provider is likely down — stop
    // draining now so we yield to POLL_MS instead of spinning.
    if (batchSent === 0) break;
    if (rows.length < BATCH) break;
  }

  return { sent, failed };
}

const once = process.argv.includes("--once");

async function main() {
  logger.info({ driver: driver.name, once }, "outbox drain starting");

  if (once) {
    // --once must fail loudly so smokes surface real errors.
    const result = await drainOnce();
    logger.info(result, "outbox drain pass complete");
    return;
  }

  // Poll mode: start the heartbeat and swallow per-pass errors so a single
  // failing pass (even the very first) never kills the poller.
  startHeartbeat(HEARTBEAT_OUTBOX);
  const pass = () =>
    drainOnce()
      .then((r) => {
        if (r.sent > 0 || r.failed > 0) logger.info(r, "outbox drain pass complete");
      })
      .catch((err) => logger.error({ err: (err as Error).message }, "outbox drain pass errored"));

  await pass();
  // A `running` guard prevents overlapping passes when a drain takes longer
  // than POLL_MS (which would otherwise double-process the same rows).
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    void pass().finally(() => {
      running = false;
    });
  }, POLL_MS);
}

void main().catch((err) => {
  logger.error({ err: (err as Error).message }, "outbox drain fatal");
  process.exit(1);
});
