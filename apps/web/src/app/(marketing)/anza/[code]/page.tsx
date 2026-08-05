import type { Metadata } from "next";
import { schoolByOutreachCode } from "@/lib/schools";
import { Funnel } from "../_funnel";

/**
 * The tracked funnel entry, reached from a recruitment SMS.
 *
 * noindex: these are thousands of near-identical URLs, and exactly one of
 * them — /anza — belongs in an index. robots.txt disallows /anza/ as well.
 */
export const metadata: Metadata = {
	title: "Book a demo",
	robots: { index: false, follow: false },
};

export default async function TrackedAnzaPage({
	params,
}: {
	params: Promise<{ code: string }>;
}) {
	const { code } = await params;

	// An unknown code must NEVER 404. Codes get truncated by SMS clients,
	// retyped by hand and forwarded between colleagues — falling through to the
	// normal funnel with an empty school field still captures the lead, and the
	// code is recorded either way.
	const school = schoolByOutreachCode(code);

	return (
		<section className="ap-tile ap-tile-light">
			<div className="ap-inner" style={{ maxWidth: 720 }}>
				<Funnel
					outreachCode={code.slice(0, 40)}
					preselected={
						school
							? {
									id: school.id,
									name: school.name,
									district: school.district,
									region: school.region,
								}
							: null
					}
				/>
			</div>
		</section>
	);
}
