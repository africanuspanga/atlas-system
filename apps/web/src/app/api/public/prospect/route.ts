import { NextResponse } from "next/server";
import { emailIsConfigured, resolveEmailDriver } from "@/lib/lead-email";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { schoolById } from "@/lib/schools";

/**
 * Funnel capture. A cold lead costs real money per SMS and arrives once, so
 * this path degrades rather than fails:
 *
 *   try store via the API   -> on failure, log and continue
 *   always email the record -> says whether it was stored
 *   error to the visitor    -> only if BOTH failed
 *
 * Test this deliberately with the database switched off.
 */

interface Payload {
	schoolId?: unknown;
	outreachCode?: unknown;
	usesSystem?: unknown;
	contactName?: unknown;
	phone?: unknown;
	preferredDay?: unknown;
	intent?: unknown;
	/** Honeypot — a real visitor never fills this. */
	website?: unknown;
}

const str = (v: unknown, max: number) =>
	typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : undefined;

export async function POST(request: Request) {
	const limited = rateLimit(`prospect:${clientIp(request)}`, 8, 60_000);
	if (!limited.ok) {
		return NextResponse.json(
			{ code: "RATE_LIMITED" },
			{ status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } },
		);
	}

	const body = (await request.json().catch(() => null)) as Payload | null;
	if (!body) return NextResponse.json({ code: "INVALID_BODY" }, { status: 400 });

	// Honeypot: answer 200 so a bot learns nothing, but record nothing.
	if (str(body.website, 200)) return NextResponse.json({ ok: true });

	const intent = body.intent === "self_tour" ? "self_tour" : "demo";

	// NEVER trust a posted school name — re-resolve it server-side from the id,
	// or a lead arrives claiming to be a school it is not.
	const schoolId = str(body.schoolId, 120);
	const school = schoolId ? schoolById(schoolId) : undefined;

	const lead = {
		schoolId: school?.id,
		schoolName: school?.name,
		district: school?.district,
		region: school?.region,
		// Recorded even when unknown: it tells us the tracked link was used.
		outreachCode: str(body.outreachCode, 40),
		usesSystem:
			typeof body.usesSystem === "boolean" ? body.usesSystem : undefined,
		contactName: str(body.contactName, 120),
		phone: str(body.phone, 40),
		preferredDay: str(body.preferredDay, 40),
		intent,
	};

	// ---- 1. try to store ---------------------------------------------------
	let stored = false;
	try {
		const api = process.env.NEXT_PUBLIC_API_URL;
		if (!api) throw new Error("NEXT_PUBLIC_API_URL not set");
		const res = await fetch(`${api}/api/v1/prospects`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(lead),
			signal: AbortSignal.timeout(8_000),
		});
		stored = res.ok;
		if (!res.ok) {
			console.error(`[lead] store failed: ${res.status}`);
		}
	} catch (err) {
		console.error("[lead] store threw:", err);
	}

	// ---- 2. always notify --------------------------------------------------
	const lines = Object.entries(lead)
		.filter(([, v]) => v !== undefined)
		.map(([k, v]) => `${k}: ${String(v)}`)
		.join("\n");

	const provenance = stored
		? "This lead IS stored in prospect_submissions."
		: "NOT STORED — the database write failed. THIS EMAIL IS THE ONLY COPY.";

	let emailed = false;
	try {
		const driver = resolveEmailDriver();
		await driver.send({
			subject: `ATLAS lead — ${lead.schoolName ?? "unnamed school"}${stored ? "" : " (NOT STORED)"}`,
			body: `${provenance}\n\n${lines}\n`,
		});
		// The console driver resolves without sending anywhere a human reads, so
		// it must never count as delivery. This is the trap the SMS drainer
		// falls into and it is not repeated here.
		emailed = emailIsConfigured;
	} catch (err) {
		console.error("[lead] email threw:", err);
	}

	// ---- 3. only fail if the lead is genuinely lost -------------------------
	if (!stored && !emailed) {
		console.error(
			"[lead] NEITHER STORED NOR EMAILED — full record:\n" + lines,
		);
		return NextResponse.json({ code: "CAPTURE_FAILED" }, { status: 503 });
	}

	return NextResponse.json({ ok: true, stored });
}
