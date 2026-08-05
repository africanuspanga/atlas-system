/**
 * One source of truth for the marketing/app host split.
 *
 * `NEXT_PUBLIC_ROOT_DOMAIN` is set in Production ONLY. Left empty in Preview
 * and locally, every host is "combined" and nothing redirects — which is what
 * keeps localhost and *.vercel.app previews usable. A preview that redirects
 * its own app routes to production cannot be tested.
 *
 * Read as a literal member expression so the bundler can inline it for client
 * code; a destructured `process.env` would not be replaced at build time.
 */
const ROOT_DOMAIN = (process.env.NEXT_PUBLIC_ROOT_DOMAIN ?? "")
	.trim()
	.toLowerCase()
	.replace(/^https?:\/\//, "")
	.replace(/[/:].*$/, "");

export const SPLIT_HOSTS = ROOT_DOMAIN !== "";
export const APP_HOST = ROOT_DOMAIN ? `app.${ROOT_DOMAIN}` : "";
export const APP_ORIGIN = ROOT_DOMAIN ? `https://${APP_HOST}` : "";
export const MARKETING_ORIGIN = ROOT_DOMAIN ? `https://${ROOT_DOMAIN}` : "";

export type Surface = "marketing" | "app" | "combined";

export function surfaceForHost(host: string | null | undefined): Surface {
	if (!SPLIT_HOSTS || !host) return "combined";
	const h = host.toLowerCase().split(":")[0].replace(/\.$/, ""); // strip port, trailing dot
	if (h === APP_HOST) return "app";
	if (h === ROOT_DOMAIN || h === `www.${ROOT_DOMAIN}`) return "marketing";
	return "combined";
}

/** Cross-host links must be plain <a>, never <Link> — see docs in proxy.ts. */
export const appHref = (p: string) => (APP_ORIGIN ? `${APP_ORIGIN}${p}` : p);
export const marketingHref = (p: string) =>
	MARKETING_ORIGIN ? `${MARKETING_ORIGIN}${p}` : p;

/** Where an authenticated user lands. The dashboard is no longer at "/". */
export const APP_HOME = "/dashboard";

/**
 * Marketing-only paths. On the app host these 307 back to the apex.
 * Adding a new marketing route means adding it here AND to PUBLIC_PREFIXES
 * below, or it will 401 for the anonymous visitors it exists to serve.
 */
export const MARKETING_ONLY_PATHS = new Set([
	"/",
	"/terms",
	"/privacy",
	"/blog",
	"/anza",
	"/tour",
	"/sitemap.xml",
]);
export const MARKETING_ONLY_PREFIXES = ["/blog/", "/anza/"];

/** Answered identically on BOTH hosts. These must NEVER redirect. */
export const SHARED_PATHS = new Set(["/robots.txt", "/favicon.ico"]);
export const SHARED_PREFIXES = ["/api/", "/_next/"];

/** Reachable without a session, on either host. */
export const PUBLIC_PREFIXES = ["/login", "/auth", "/invite"];

export function isMarketingPath(path: string): boolean {
	return (
		MARKETING_ONLY_PATHS.has(path) ||
		MARKETING_ONLY_PREFIXES.some((p) => path.startsWith(p))
	);
}

export function isSharedPath(path: string): boolean {
	return (
		SHARED_PATHS.has(path) || SHARED_PREFIXES.some((p) => path.startsWith(p))
	);
}

export function isPublicPath(path: string): boolean {
	return (
		isMarketingPath(path) ||
		isSharedPath(path) ||
		PUBLIC_PREFIXES.some((p) => path.startsWith(p))
	);
}

/**
 * Decide which surface a path belongs to using a NORMALISED copy, so that
 * `/blog/%2e%2e/dashboard` is judged as the app path the router will actually
 * serve — not as marketing. Always redirect with the RAW pathname, because
 * normalising lowercases and a case-sensitive slug would 404.
 */
export function normalisePath(rawPath: string): string {
	let decoded = rawPath;
	for (let i = 0; i < 3; i++) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			break; // malformed escape — judge on what we have
		}
	}
	decoded = decoded.replace(/\\/g, "/").toLowerCase();

	const out: string[] = [];
	for (const seg of decoded.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(seg);
	}
	return `/${out.join("/")}`;
}
