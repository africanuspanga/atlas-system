import type { MetadataRoute } from "next";
import { FREE_SMS } from "@/lib/offer";

/**
 * Web app manifest, answered identically on BOTH hosts (see SHARED_PATHS in
 * lib/hosts.ts). `start_url` is relative on purpose: on the apex it installs
 * the marketing site, on app.* it installs the product, and neither one has to
 * know the other's origin.
 *
 * NOTE: this is served at /manifest.webmanifest, which has no image extension,
 * so the proxy matcher does NOT exclude it. It must stay in SHARED_PATHS or it
 * 401s for the anonymous visitor whose browser asked for it.
 */
export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "ATLAS. School management for Tanzanian schools.",
		short_name: "ATLAS",
		description: `Fees and arrears, attendance, marks and report cards, and the SMS that reaches parents. One price for the whole school, ${FREE_SMS.toLocaleString("en-US")} SMS a year included.`,
		start_url: "/",
		display: "standalone",
		background_color: "#ffffff",
		theme_color: "#0052ff",
		lang: "en",
		categories: ["education", "business", "productivity"],
		icons: [
			{ src: "/icon.svg", type: "image/svg+xml", sizes: "any" },
			{ src: "/apple-icon.png", type: "image/png", sizes: "180x180" },
		],
	};
}
