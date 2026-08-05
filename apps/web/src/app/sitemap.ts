import type { MetadataRoute } from "next";
import { ARTICLES } from "./(marketing)/blog/_articles";
import { MARKETING_ORIGIN } from "@/lib/hosts";

/**
 * Marketing sitemap. ATLAS is English-only, so there is one URL per page and
 * no language variants.
 *
 * /anza is listed; /anza/<code> deliberately is NOT — those are thousands of
 * near-identical tracked URLs, noindexed on the page and disallowed in
 * robots.txt.
 */
export default function sitemap(): MetadataRoute.Sitemap {
	const base = MARKETING_ORIGIN || "http://localhost:3002";
	const now = new Date();

	return [
		{ url: `${base}/`, lastModified: now, priority: 1 },
		{ url: `${base}/anza`, lastModified: now, priority: 0.9 },
		{ url: `${base}/tour`, lastModified: now, priority: 0.8 },
		{ url: `${base}/blog`, lastModified: now, priority: 0.7 },
		...ARTICLES.map((a) => ({
			url: `${base}/blog/${a.slug}`,
			lastModified: new Date(`${a.published}T00:00:00Z`),
			priority: 0.6,
		})),
		{ url: `${base}/terms`, lastModified: now, priority: 0.3 },
		{ url: `${base}/privacy`, lastModified: now, priority: 0.3 },
	];
}
