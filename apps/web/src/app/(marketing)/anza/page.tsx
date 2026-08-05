import type { Metadata } from "next";
import { Funnel } from "./_funnel";

export const metadata: Metadata = {
	title: "Book a demo",
	description:
		"See ATLAS with your own school's numbers. One price, everything included.",
	alternates: { canonical: "/anza" },
};

/** The untracked funnel entry — the one /anza URL that belongs in an index. */
export default function AnzaPage() {
	return (
		<section className="ap-tile ap-tile-light">
			<div className="ap-inner" style={{ maxWidth: 720 }}>
				<Funnel preselected={null} />
			</div>
		</section>
	);
}
