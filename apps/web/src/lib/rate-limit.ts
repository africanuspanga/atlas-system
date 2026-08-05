/**
 * Per-IP rate limiting for the anonymous public endpoints.
 *
 * In-memory and therefore per-instance: it blunts scraping and accidental
 * hammering, it is not a hard guarantee across a fleet. That is the right
 * trade here — the alternative is a shared store, and the whole point of the
 * funnel is that it keeps working when the database is asleep.
 */

interface Bucket {
	count: number;
	resetAt: number;
}

const buckets = new Map<string, Bucket>();
const MAX_TRACKED = 10_000;

export function rateLimit(
	key: string,
	limit: number,
	windowMs: number,
): { ok: boolean; retryAfterSec: number } {
	const now = Date.now();
	const bucket = buckets.get(key);

	if (!bucket || bucket.resetAt <= now) {
		// Cheap guard against unbounded growth under a spray of distinct IPs.
		if (buckets.size >= MAX_TRACKED) {
			for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
			if (buckets.size >= MAX_TRACKED) buckets.clear();
		}
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		return { ok: true, retryAfterSec: 0 };
	}

	bucket.count += 1;
	if (bucket.count > limit) {
		return {
			ok: false,
			retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
		};
	}
	return { ok: true, retryAfterSec: 0 };
}

/** Best-effort client IP from the proxy headers Vercel sets. */
export function clientIp(request: Request): string {
	const fwd = request.headers.get("x-forwarded-for");
	if (fwd) return fwd.split(",")[0].trim();
	return request.headers.get("x-real-ip") ?? "unknown";
}
