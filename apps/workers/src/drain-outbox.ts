/**
 * Notification outbox drain — no Redis required. Polls pending rows in
 * public.notification_outbox and delivers them through the configured SMS
 * driver. A database RPC atomically applies the tenant's monthly SMS limit and
 * claims pending→sending. Only a successful provider response marks a row sent;
 * stale claims recover after 10 minutes.
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
const MAX_ATTEMPTS = 8;
const POLL_MS = Number(process.env.OUTBOX_POLL_MS ?? 15_000);

/** Renders the SMS text for an outbox row from its template + payload. */
function renderBodyRaw(template: string, payload: Record<string, unknown>): string {
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
        ? ` Matibabu: ${payload.treatment.slice(0, 120)}.`
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

/** One notification can never fan out into an unbounded multipart SMS. */
function renderBody(template: string, payload: Record<string, unknown>): string {
  const body = renderBodyRaw(template, payload);
  return body.length > 480 ? `${body.slice(0, 477)}...` : body;
}

interface ClaimedOutboxRow {
  status: "claimed" | "limit" | "unavailable";
  id: string;
  tenantId: string;
  recipient: string;
  template: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function drainOnce(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  // A process may have stopped after claiming but before completing delivery.
  // Provider calls time out at 15s, so a 10-minute claim is unquestionably stale.
  const staleBefore = new Date(Date.now() - 10 * 60_000).toISOString();
  const { error: recoveryError } = await supabase
    .from("notification_outbox")
    .update({
      status: "pending",
      claimed_at: null,
      next_attempt_at: new Date().toISOString(),
      last_error: "RECOVERED_STALE_CLAIM",
    })
    .eq("status", "sending")
    .lt("claimed_at", staleBefore);
  if (recoveryError) throw new Error(recoveryError.message);

  for (;;) {
    // !inner join so draft/suspended/archived tenants never send queued
    // messages; next_attempt_at gate skips rows still in backoff.
    const { data: rows, error } = await supabase
      .from("notification_outbox")
      .select("id, tenants!inner(status)")
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
    let attemptedDelivery = 0;
    for (const row of rows as Array<{ id: string }>) {
      // claim_notification serialises usage checks per tenant, so multiple
      // worker replicas cannot race past the plan's smsMonthly allowance.
      const { data, error: claimError } = await supabase.rpc(
        "claim_notification",
        { p_id: row.id },
      );
      if (claimError) throw new Error(claimError.message);
      const claimed = data as ClaimedOutboxRow;
      if (claimed.status === "limit") {
        failed += 1;
        continue;
      }
      if (claimed.status !== "claimed") continue;

      attemptedDelivery += 1;
      const body = renderBody(claimed.template, claimed.payload).slice(0, 480);
      try {
        await driver.send({ recipient: claimed.recipient, body });
        const { error: sentError } = await supabase
          .from("notification_outbox")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            claimed_at: null,
            last_error: null,
          })
          .eq("id", claimed.id)
          .eq("status", "sending");
        if (sentError) throw new Error(`SMS_STATUS_UPDATE_FAILED: ${sentError.message}`);
        sent += 1;
        batchSent += 1;
      } catch (err) {
        const attempts = claimed.attempts;
        const exhausted = attempts >= MAX_ATTEMPTS;
        const { error: releaseError } = await supabase
          .from("notification_outbox")
          .update({
            status: exhausted ? "failed" : "pending",
            sent_at: null,
            claimed_at: null,
            last_error: (err as Error).message.slice(0, 300),
            ...(exhausted
              ? {}
              : {
                  next_attempt_at: new Date(
                    Date.now() + Math.min(2 ** attempts, 360) * 60_000,
                  ).toISOString(),
                }),
          })
          .eq("id", claimed.id)
          .eq("status", "sending");
        if (releaseError) {
          logger.error(
            { id: claimed.id, err: releaseError.message },
            "failed to release outbox claim",
          );
        }
        if (exhausted) failed += 1;
        logger.error(
          { id: claimed.id, tenantId: claimed.tenantId, attempts, err: (err as Error).message },
          "outbox delivery failed",
        );
      }
    }
    // A batch that delivered nothing means the provider is likely down — stop
    // draining now so we yield to POLL_MS instead of spinning.
    if (attemptedDelivery > 0 && batchSent === 0) break;
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
