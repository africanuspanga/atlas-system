import { NextResponse } from "next/server";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { MIN_QUERY, searchSchools } from "@/lib/schools";

/**
 * Anonymous school autocomplete for the funnel.
 *
 * Serves name, district and region ONLY. No phone, no email, and never the
 * outreach code — echoing the code here would let anyone map codes to schools
 * in bulk. Reads a static bundled dataset, so it keeps answering when the
 * database is asleep.
 */
export async function GET(request: Request) {
	const limited = rateLimit(`schools:${clientIp(request)}`, 30, 60_000);
	if (!limited.ok) {
		return NextResponse.json(
			{ code: "RATE_LIMITED" },
			{ status: 429, headers: { "Retry-After": String(limited.retryAfterSec) } },
		);
	}

	const query = new URL(request.url).searchParams.get("q") ?? "";
	if (query.length > 80) {
		return NextResponse.json({ code: "QUERY_TOO_LONG" }, { status: 400 });
	}
	if (query.trim().length < MIN_QUERY) {
		return NextResponse.json({ schools: [] });
	}

	return NextResponse.json(
		{ schools: searchSchools(query) },
		{ headers: { "Cache-Control": "no-store" } },
	);
}
