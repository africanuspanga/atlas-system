import Link from "next/link";
import { appHref } from "@/lib/hosts";

const COLUMNS = [
	{
		heading: "Product",
		links: [
			{ label: "What it does", href: "#modules" },
			{ label: "Pricing", href: "#pricing" },
			{ label: "How it works", href: "#how" },
			{ label: "Take a look around", href: "/tour" },
		],
	},
	{
		heading: "Learn",
		links: [
			{ label: "Blog", href: "/blog" },
			{ label: "Questions", href: "#faq" },
		],
	},
	{
		heading: "School",
		links: [
			{ label: "Book a demo", href: "/anza" },
			{ label: "Sign in", href: appHref("/login"), external: true },
		],
	},
	{
		heading: "Legal",
		links: [
			{ label: "Terms", href: "/terms" },
			{ label: "Privacy", href: "/privacy" },
		],
	},
];

export function MarketingFooter() {
	return (
		<footer className="ap-footer">
			<div className="ap-inner-wide" style={{ paddingInline: "var(--ap-lg)" }}>
				<div
					style={{
						display: "grid",
						gap: "var(--ap-xl)",
						gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
					}}
				>
					{COLUMNS.map((col) => (
						<div key={col.heading}>
							<p
								className="ap-caption-strong"
								style={{ marginBottom: "var(--ap-xs)" }}
							>
								{col.heading}
							</p>
							{col.links.map((l) =>
								"external" in l && l.external ? (
									<a className="ap-footer-link" href={l.href} key={l.label}>
										{l.label}
									</a>
								) : (
									<Link className="ap-footer-link" href={l.href} key={l.label}>
										{l.label}
									</Link>
								),
							)}
						</div>
					))}
				</div>

				<div
					style={{
						marginTop: "var(--ap-xl)",
						paddingTop: "var(--ap-lg)",
						borderTop: "1px solid var(--ap-hairline)",
					}}
				>
					<p className="ap-fine">
						ATLAS — school management for Tanzania. Dar es Salaam, Tanzania.
					</p>
					<p className="ap-fine">
						© {new Date().getFullYear()} ATLAS. All rights reserved.
					</p>
				</div>
			</div>
		</footer>
	);
}
