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

const consoleDriver: SmsDriver = {
  name: "console",
  send(message) {
    logger.info(
      { recipient: message.recipient, body: message.body },
      "SMS (console driver — not actually sent)",
    );
    return Promise.resolve();
  },
};

function beemDriver(apiKey: string, secretKey: string, senderId: string): SmsDriver {
  return {
    name: "beem",
    async send(message) {
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
          message: message.body,
          recipients: [
            // Beem expects msisdn without the leading +
            { recipient_id: 1, dest_addr: message.recipient.replace(/^\+/, "") },
          ],
        }),
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
      logger.warn("SMS_DRIVER=beem but BEEM_API_KEY/BEEM_SECRET_KEY missing — using console driver");
      return consoleDriver;
    }
    return beemDriver(apiKey, secretKey, process.env.BEEM_SENDER_ID ?? "ATLAS");
  }
  return consoleDriver;
}
