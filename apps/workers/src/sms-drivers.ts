/**
 * SMS delivery drivers. The console driver logs instead of sending — the
 * default for development. The Beem driver targets Beem Africa
 * (https://docs.beem.africa/), the gateway most Tanzanian schools use;
 * it activates when SMS_DRIVER=beem and BEEM_API_KEY/BEEM_SECRET_KEY are set.
 */
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export interface SmsMessage {
  recipient: string;
  body: string;
}

export interface SmsDriver {
  name: string;
  send(message: SmsMessage): Promise<void>;
}

/**
 * Normalises a recipient to a Beem-ready MSISDN. Numbers are stored canonically
 * as local `0XXXXXXXXX` but Beem needs international `255XXXXXXXXX`; already-
 * international numbers pass through unchanged. Exported for unit tests.
 */
export function toMsisdn(recipient: string): string {
  const digits = recipient.replace(/\D/g, "");
  return /^0\d{9}$/.test(digits) ? "255" + digits.slice(1) : digits;
}

const consoleDriver: SmsDriver = {
  name: "console",
  send(message) {
    logger.info(
      {
        recipientSuffix: message.recipient.replace(/\D/g, "").slice(-4),
        characters: message.body.length,
      },
      "SMS (console driver — not actually sent)",
    );
    return Promise.resolve();
  },
};

function beemDriver(apiKey: string, secretKey: string, senderId: string): SmsDriver {
  return {
    name: "beem",
    async send(message) {
      const recipient = toMsisdn(message.recipient);
      if (!/^255\d{9}$/.test(recipient)) {
        throw new Error("SMS_INVALID_TANZANIA_RECIPIENT");
      }
      const response = await fetch("https://apisms.beem.africa/v1/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${apiKey}:${secretKey}`).toString("base64")}`,
        },
        body: JSON.stringify({
          source_addr: senderId,
          schedule_time: "",
          encoding: 0,
          message: message.body.slice(0, 480),
          recipients: [
            // Beem expects an international msisdn (255XXXXXXXXX), no leading +.
            { recipient_id: 1, dest_addr: recipient },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`Beem ${response.status}: ${text.slice(0, 200)}`);
      }
    },
  };
}

export function resolveDriver(): SmsDriver {
  const requested = process.env.SMS_DRIVER ?? "console";
  if (requested === "beem") {
    const apiKey = process.env.BEEM_API_KEY;
    const secretKey = process.env.BEEM_SECRET_KEY;
    if (!apiKey || !secretKey) {
      throw new Error(
        "SMS_DRIVER=beem requires BEEM_API_KEY and BEEM_SECRET_KEY",
      );
    }
    return beemDriver(apiKey, secretKey, process.env.BEEM_SENDER_ID ?? "ATLAS");
  }
  if (requested !== "console") {
    throw new Error(`Unsupported SMS_DRIVER: ${requested}`);
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SMS_DRIVER=console is disabled in production; configure SMS_DRIVER=beem",
    );
  }
  return consoleDriver;
}
