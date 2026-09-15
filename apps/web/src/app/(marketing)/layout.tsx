import type { Metadata } from "next";
import { MARKETING_ORIGIN } from "@/lib/hosts";
import { FREE_SMS } from "@/lib/offer";
import { MarketingFooter } from "./_components/footer";
import { MarketingNav } from "./_components/nav";
import "./marketing.css";

/**
 * The marketing surface. Everything inside `.atlas-marketing` uses the
 * Apple-derived design language (see marketing.css and
 * docs/design-marketing.md); the product dashboard keeps design.md.
 */

/**
 * A head teacher searching for this types "school management system Tanzania",
 * so the search terms lead. The brand is NOT in this string: the root layout's
 * title template already appends it to this default, and naming it here too
 * rendered the brand twice in the tab. Social cards are not templated, so those
 * carry the brand themselves.
 */
const TITLE = "School management software for Tanzanian schools";
const SOCIAL_TITLE = "ATLAS. School management for Tanzanian schools.";

/**
 * Templated off the offer rather than typed out, for the same reason the price
 * is: a number written twice is a number that will disagree with itself. The
 * price itself stays out of the description, because a figure in a search
 * result outlives every edit to the page it came from.
 */
const DESCRIPTION = `Fees and arrears, attendance, marks and report cards, and the SMS that reaches parents. One price for the whole school, ${FREE_SMS.toLocaleString("en-US")} SMS a year included.`;

/** The social card is the same claim, shortened to fit the crop. */
const SOCIAL_DESCRIPTION =
	"Fees and arrears, attendance, marks and report cards, and the messages that go to parents. Built for Tanzanian schools.";

export const metadata: Metadata = {
	metadataBase: new URL(MARKETING_ORIGIN || "http://localhost:3000"),
	title: {
		default: TITLE,
		template: "%s · ATLAS",
	},
	description: DESCRIPTION,
	applicationName: "ATLAS",
	alternates: { canonical: "/" },
	openGraph: {
		type: "website",
		siteName: "ATLAS",
		locale: "en_TZ",
		url: "/",
		title: SOCIAL_TITLE,
		description: SOCIAL_DESCRIPTION,
	},
	twitter: {
		card: "summary_large_image",
		title: SOCIAL_TITLE,
		description: SOCIAL_DESCRIPTION,
	},
	robots: {
		index: true,
		follow: true,
		googleBot: { index: true, follow: true, "max-image-preview": "large" },
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
