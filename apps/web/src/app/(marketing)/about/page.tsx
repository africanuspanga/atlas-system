import type { Metadata } from "next";
import Link from "next/link";

/**
 * Who is behind ATLAS, and where it is going.
 *
 * Written for the two readers the landing page does not serve: an investor or
 * partner checking who built this, and a school owner who wants to know the
 * company will still be here in five years.
 *
 * The roadmap section is explicitly labelled as not yet in the product. The
 * landing page promises "nothing here is coming soon", so anything future
 * tense lives here, fenced off, and never next to the price.
 *
 * Facts only. No school is named without its written permission, and there
 * are no testimonials (see pillars.ts for why).
 */
export const metadata: Metadata = {
	title: "About",
	description:
		"Who builds ATLAS, what we believe about running a school, and where the platform is going next.",
	alternates: { canonical: "/about" },
};

const CONTACT_EMAIL = "africanus@driftmark.co.tz";

const BELIEFS = [
	{
		title: "One record, not five systems",
		body: "A payment, a balance and a term's collection figure should be the same fact seen from three angles. When fees, marks and attendance live in one place, the numbers stop disagreeing.",
	},
	{
		title: "Money must be auditable",
		body: "Financial records cannot be edited, only reversed, and every report reconciles to the ledger. A board should be able to trust the figure without phoning the bursar.",
	},
	{
		title: "AI that cannot invent a number",
		body: "The assistant reads only what your role allows, takes money figures from the reports rather than doing its own arithmetic, and can only propose changes for a person to confirm.",
	},
	{
		title: "Parents should hear early",
		body: "A parent who learns about an absence the same day can act on it. One who learns at the end of term cannot. The basic phone counts, so SMS is part of the product.",
	},
];

const TODAY = [
	{ figure: "4", label: "Schools signed, in Karatu, Dar es Salaam, Arusha and Zanzibar" },
	{ figure: "25", label: "Modules, from fees and payroll to the clinic and the library" },
	{ figure: "3", label: "Ways in: the web, an Android app and an iPhone app" },
];

const NEXT = [
	{
		title: "Planning help for teachers",
		body: "Schemes of work, lesson plans, question papers and marking guides drafted against the national syllabus for the teacher's own class. The teacher edits and approves every one.",
	},
	{
		title: "A weekly note for parents",
		body: "Attendance, new marks and fees due every Friday, by app or SMS, with one practical thing to work on at home.",
	},
	{
		title: "Learning for students",
		body: "Holiday revision papers and mock national exams, marked instantly, and a tutor that starts from the topics a student actually found hard in class.",
	},
	{
		title: "Beyond Tanzania",
		body: "Kenya and Uganda next. The syllabus, exam formats, tax bands and grading scales are settings, so a new country is new content rather than a new system.",
	},
];

export default function AboutPage() {
	return (
		<>
			<section className="ap-tile ap-tile-light">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<p className="ap-eyebrow">About ATLAS</p>
					<h1 className="ap-hero" style={{ marginTop: "var(--ap-sm)" }}>
						Built in Tanzania, for the schools that teach its children.
					</h1>
					<p
						className="ap-lead"
						style={{
							marginTop: "var(--ap-md)",
							color: "var(--ap-ink-80)",
							maxWidth: 680,
							marginInline: "auto",
						}}
					>
						ATLAS runs a private school from one place: fees, attendance, marks
						and report cards, payroll, and the messages that reach parents. This
						page is about the people behind it and where it is going.
					</p>
				</div>
			</section>

			<section className="ap-tile ap-tile-parchment">
				<div className="ap-inner-wide">
					<div className="ap-split">
						<div>
							<p className="ap-eyebrow">How it started</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								Eighteen months in schools before a line of code.
							</h2>
						</div>
						<div>
							<p className="ap-body" style={{ color: "var(--ap-ink-80)" }}>
								ATLAS was founded by Africanus Panga. Before building anything,
								he spent a year and a half in the offices of private schools,
								watching how fees were recorded, how report cards were put
								together, and what a head teacher could and could not answer
								when the board asked.
							</p>
							<p
								className="ap-body"
								style={{ marginTop: "var(--ap-md)", color: "var(--ap-ink-80)" }}
							>
								The answer was the same everywhere. The school already kept
								the information, in exercise books, spreadsheets and teachers&apos;
								mark books, but none of it could be added together. ATLAS was
								built over the following nine months to fix exactly that, and
								the first four schools signed without a sales team.
							</p>
						</div>
					</div>
				</div>
			</section>

			<section className="ap-tile ap-tile-light">
				<div className="ap-inner-wide">
					<div className="ap-head">
						<div>
							<p className="ap-eyebrow">What we believe</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								Four rules the product
								<br />
								is built on.
							</h2>
						</div>
						<p className="ap-body" style={{ color: "var(--ap-ink-80)" }}>
							These are written into how ATLAS is engineered, not just how it is
							described. Each one is something a school can check for itself.
						</p>
					</div>

					<div className="ap-grid-4" style={{ marginTop: "var(--ap-xxl)" }}>
						{BELIEFS.map((b) => (
							<div className="ap-card" key={b.title}>
								<p className="ap-tagline">{b.title}</p>
								<p
									className="ap-caption"
									style={{ marginTop: "var(--ap-xs)", color: "var(--ap-ink-80)" }}
								>
									{b.body}
								</p>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="ap-tile ap-tile-dark">
				<div className="ap-inner-wide">
					<div className="ap-head">
						<div>
							<p className="ap-eyebrow">Where we are today</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								Built, and in schools.
							</h2>
						</div>
						<p className="ap-body" style={{ color: "var(--ap-body-muted)" }}>
							Four regions rather than one city, on purpose: a system that works
							in Karatu and in Zanzibar works for the schools in between.
						</p>
					</div>

					<div className="ap-grid-3" style={{ marginTop: "var(--ap-xxl)" }}>
						{TODAY.map((t) => (
							<div
								key={t.label}
								style={{
									borderTop: "1px solid rgba(255,255,255,0.14)",
									paddingTop: "var(--ap-md)",
								}}
							>
								<p
									className="ap-figure"
									style={{ color: "var(--ap-primary-on-dark)" }}
								>
									{t.figure}
								</p>
								<p
									className="ap-body"
									style={{
										marginTop: "var(--ap-xs)",
										color: "var(--ap-body-muted)",
									}}
								>
									{t.label}
								</p>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="ap-tile ap-tile-parchment">
				<div className="ap-inner-wide">
					<div className="ap-head">
						<div>
							<p className="ap-eyebrow">Where we are going</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								From running the school
								<br />
								to helping it teach.
							</h2>
						</div>
						<p className="ap-body" style={{ color: "var(--ap-ink-80)" }}>
							The record that knows every fee and every mark can do more than
							keep the office in order. These are in development and are not
							part of the product or the price today.
						</p>
					</div>

					<div className="ap-grid-4" style={{ marginTop: "var(--ap-xxl)" }}>
						{NEXT.map((n) => (
							<div className="ap-card" key={n.title}>
								<p className="ap-eyebrow" style={{ color: "var(--ap-ink-48)" }}>
									In development
								</p>
								<p className="ap-tagline" style={{ marginTop: "var(--ap-xs)" }}>
									{n.title}
								</p>
								<p
									className="ap-caption"
									style={{ marginTop: "var(--ap-xs)", color: "var(--ap-ink-80)" }}
								>
									{n.body}
								</p>
							</div>
						))}
					</div>
				</div>
			</section>

			<section className="ap-tile ap-tile-dark">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h2 className="ap-display">Talk to us.</h2>
					<p
						className="ap-lead"
						style={{ marginTop: "var(--ap-md)", color: "var(--ap-body-muted)" }}
					>
						Schools: a demo takes about 30 minutes, with your own numbers.
						<br />
						Partners and investors: write to the founder directly.
					</p>
					<div
						style={{
							marginTop: "var(--ap-xl)",
							display: "flex",
							gap: "var(--ap-sm)",
							justifyContent: "center",
							flexWrap: "wrap",
						}}
					>
						<Link className="ap-btn" href="/anza">
							Book a demo
						</Link>
						<a className="ap-btn ap-btn-ghost" href={`mailto:${CONTACT_EMAIL}`}>
							Email the founder
						</a>
					</div>
				</div>
			</section>
		</>
	);
}
