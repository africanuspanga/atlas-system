import { headers } from "next/headers";
import type { MetadataRoute } from "next";
import { MARKETING_ORIGIN, surfaceForHost } from "@/lib/hosts";

/**
 * Different robots.txt per host — and NEVER a redirect for this path (the
 * proxy treats it as shared), or the app host would inherit a robots file that
 * invites crawlers in.
 *
 * There is nothing to index on the app host, and letting a crawler in would
 * split ranking signals across two hosts.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
	const host = (await headers()).get("host");

	if (surfaceForHost(host) === "app") {
		return { rules: [{ userAgent: "*", disallow: "/" }] };
	}

	return {
		rules: [
			{
				userAgent: "*",
				allow: "/",
				// /anza/<code> is thousands of near-identical tracked URLs; exactly
				// one of them, /anza, belongs in an index.
				disallow: ["/anza/", "/dashboard", "/api/", "/auth/", "/invite/"],
			},
		],
		sitemap: MARKETING_ORIGIN
			? `${MARKETING_ORIGIN}/sitemap.xml`
			: undefined,
	};
}
