/**
 * Lead notification driver.
 *
 * Mirrors apps/workers/src/sms-drivers.ts, including its production guard —
 * but deliberately NOT its known failure mode. The SMS drainer's console
 * driver logs and the row is still marked sent, so you can ship believing SMS
 * works when nothing was sent. Here the driver reports what it actually did,
 * and the caller tells the visitor and the log the truth.
 *
 * Configure with LEAD_EMAIL_DRIVER=resend, RESEND_API_KEY and LEAD_EMAIL_TO.
 */

export interface LeadEmail {
	subject: string;
	body: string;
}

export interface EmailDriver {
	name: string;
	/** Resolves only if the message really left. Throws otherwise. */
	send(message: LeadEmail): Promise<void>;
}

const consoleDriver: EmailDriver = {
	name: "console",
	send(message) {
		// error level on purpose: with no provider configured this log IS the
		// lead, and it must be findable.
		console.error(
			"[lead] console driver — NOT actually emailed. Full record follows:\n" +
				`subject: ${message.subject}\n${message.body}`,
		);
		return Promise.resolve();
	},
};

function resendDriver(apiKey: string, to: string, from: string): EmailDriver {
	return {
		name: "resend",
		async send(message) {
			const response = await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					from,
					to: [to],
					subject: message.subject,
					text: message.body,
				}),
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`Resend ${response.status}: ${text.slice(0, 200)}`);
			}
		},
	};
}

export function resolveEmailDriver(): EmailDriver {
	const requested = process.env.LEAD_EMAIL_DRIVER ?? "console";

	if (requested === "resend") {
		const apiKey = process.env.RESEND_API_KEY;
		const to = process.env.LEAD_EMAIL_TO;
		if (!apiKey || !to) {
			throw new Error(
				"LEAD_EMAIL_DRIVER=resend requires RESEND_API_KEY and LEAD_EMAIL_TO",
			);
		}
		return resendDriver(
			apiKey,
			to,
			process.env.LEAD_EMAIL_FROM ?? "atlas@atlas-system.co.tz",
		);
	}

	if (requested !== "console") {
		throw new Error(`Unsupported LEAD_EMAIL_DRIVER: ${requested}`);
	}
	return consoleDriver;
}

/** True when the resolved driver cannot actually deliver anywhere. */
export const emailIsConfigured = (process.env.LEAD_EMAIL_DRIVER ?? "console") !== "console";
