import type { Metadata } from "next";
import { MARKETING_ORIGIN } from "@/lib/hosts";
import { MarketingFooter } from "./_components/footer";
import { MarketingNav } from "./_components/nav";
import "./marketing.css";

/**
 * The marketing surface. Everything inside `.atlas-marketing` uses the
 * Apple-derived design language (see marketing.css and
 * docs/design-marketing.md); the product dashboard keeps design.md.
 */
export const metadata: Metadata = {
	metadataBase: new URL(MARKETING_ORIGIN || "http://localhost:3002"),
	title: {
		default: "ATLAS — school management for Tanzania",
		template: "%s · ATLAS",
	},
	description:
		"ATLAS runs the whole school: fees and arrears, attendance, marks and report cards, and messages to parents. One price, everything included.",
	alternates: { canonical: "/" },
	openGraph: {
		type: "website",
		siteName: "ATLAS",
		locale: "en_TZ",
		title: "ATLAS — school management for Tanzania",
		description:
			"Fees and arrears, attendance, marks and report cards, and messages to parents — in one system.",
	},
	twitter: {
		card: "summary_large_image",
		title: "ATLAS — school management for Tanzania",
		description:
			"Fees and arrears, attendance, marks and report cards, and messages to parents — in one system.",
	},
};

export default function MarketingLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div className="atlas-marketing">
			<MarketingNav />
			<main>{children}</main>
			<MarketingFooter />
		</div>
	);
}
