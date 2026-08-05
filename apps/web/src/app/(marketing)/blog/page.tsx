import type { Metadata } from "next";
import Link from "next/link";
import { ARTICLES } from "./_articles";

export const metadata: Metadata = {
	title: "Blog",
	description:
		"Practical writing on running a school: fees and arrears, attendance, report cards, and what a school system actually changes.",
	alternates: { canonical: "/blog" },
};

const fmtDate = (iso: string) =>
	new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});

export default function BlogIndex() {
	return (
		<section className="ap-tile ap-tile-light">
			<div className="ap-inner">
				<h1 className="ap-hero">Writing</h1>
				<p
					className="ap-lead"
					style={{ marginTop: "var(--ap-md)", color: "var(--ap-ink-80)" }}
				>
					How schools actually run, and what changes when the information stops
					being scattered.
				</p>

				<div
					style={{
						marginTop: "var(--ap-xxl)",
						display: "grid",
						gap: "var(--ap-lg)",
					}}
				>
					{ARTICLES.map((a) => (
						<article
							key={a.slug}
							style={{
								borderTop: "1px solid var(--ap-hairline)",
								paddingTop: "var(--ap-lg)",
							}}
						>
							<p className="ap-caption" style={{ color: "var(--ap-ink-48)" }}>
								{fmtDate(a.published)} · {a.readingMinutes} min read
							</p>
							<h2 className="ap-display-md" style={{ marginTop: "var(--ap-xxs)" }}>
								<Link className="ap-link" href={`/blog/${a.slug}`}>
									{a.title}
								</Link>
							</h2>
							<p
								className="ap-body"
								style={{
									marginTop: "var(--ap-xs)",
									color: "var(--ap-ink-80)",
									maxWidth: 680,
								}}
							>
								{a.description}
							</p>
						</article>
					))}
				</div>
			</div>
		</section>
	);
}
