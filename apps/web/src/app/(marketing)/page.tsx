import Link from "next/link";
import { MARKETING_ORIGIN, appHref } from "@/lib/hosts";
import {
	FREE_SMS,
	INCLUSIONS,
	OFFER,
	PRICE_TZS,
	fmtTZS,
	perStudentPerMonth,
	perStudentPerYear,
} from "@/lib/offer";
import { ALSO, FAQ, MODULES, PROBLEMS, STEPS } from "./_components/content";
import { AppWindow } from "./_components/shot";

/**
 * The landing page. Tile rhythm: light hero -> parchment -> light -> dark ->
 * light -> parchment -> dark pricing -> light FAQ -> parchment close. The
 * surface change is the section divider; there are no rules or borders.
 *
 * Price and inclusions render from lib/offer.ts, and the JSON-LD below is
 * generated from the same constants — so the structured data can never
 * advertise a price the visible page has stopped showing.
 */
export default function LandingPage() {
	const jsonLd = [
		{
			"@context": "https://schema.org",
			"@type": "Organization",
			name: "ATLAS",
			url: MARKETING_ORIGIN || undefined,
			areaServed: "TZ",
		},
		{
			"@context": "https://schema.org",
			"@type": "WebSite",
			name: "ATLAS",
			url: MARKETING_ORIGIN || undefined,
			inLanguage: "en-TZ",
		},
		{
			"@context": "https://schema.org",
			"@type": "SoftwareApplication",
			name: "ATLAS",
			applicationCategory: "BusinessApplication",
			operatingSystem: "Web, iOS, Android",
			description:
				"School management for Tanzania: fees and arrears, attendance, marks and report cards, and messages to parents.",
			offers: {
				"@type": "Offer",
				price: String(PRICE_TZS),
				priceCurrency: OFFER.currency,
				priceValidUntil: undefined,
				category: "Annual subscription",
			},
		},
		{
			"@context": "https://schema.org",
			"@type": "FAQPage",
			mainEntity: FAQ.map((f) => ({
				"@type": "Question",
				name: f.q,
				acceptedAnswer: { "@type": "Answer", text: f.a },
			})),
		},
	];

	return (
		<>
			<script
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
			/>

			{/* ---- hero ------------------------------------------------- */}
			<section className="ap-tile ap-tile-light">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h1 className="ap-hero">The whole school, in one place.</h1>
					<p
						className="ap-lead"
						style={{
							marginTop: "var(--ap-md)",
							color: "var(--ap-ink-80)",
							maxWidth: 720,
							marginInline: "auto",
						}}
					>
						Fees and arrears, attendance, marks and report cards, and the
						messages that go to parents. One system, one price.
					</p>
					<div
						style={{
							display: "flex",
							gap: "var(--ap-sm)",
							justifyContent: "center",
							flexWrap: "wrap",
							marginTop: "var(--ap-xl)",
						}}
					>
						<Link className="ap-btn" href="/anza">
							Book a demo
						</Link>
						<a className="ap-btn-ghost" href={appHref("/login")}>
							Sign in
						</a>
					</div>
					<div style={{ marginTop: "var(--ap-xxl)" }}>
						<AppWindow
							alt="The ATLAS dashboard showing today's attendance, fee collection and outstanding balances"
							needs="/dashboard as a head teacher, demo tenant"
							priority
						/>
					</div>
				</div>
			</section>

			{/* ---- the problem ------------------------------------------ */}
			<section className="ap-tile ap-tile-parchment">
				<div className="ap-inner">
					<h2 className="ap-display">What a term actually looks like.</h2>
					<ul
						style={{
							marginTop: "var(--ap-xl)",
							display: "grid",
							gap: "var(--ap-md)",
							gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
							listStyle: "none",
							padding: 0,
						}}
					>
						{PROBLEMS.map((p) => (
							<li className="ap-body" key={p} style={{ color: "var(--ap-ink-80)" }}>
								{p}
							</li>
						))}
					</ul>
				</div>
			</section>

			{/* ---- modules, by role ------------------------------------- */}
			<section className="ap-tile ap-tile-light" id="modules">
				<div className="ap-inner-wide">
					<h2 className="ap-display" style={{ textAlign: "center" }}>
						Four people. Four different questions.
					</h2>
					<div
						style={{
							marginTop: "var(--ap-xxl)",
							display: "grid",
							gap: "var(--ap-lg)",
							gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
						}}
					>
						{MODULES.map((g) => (
							<div className="ap-card" key={g.role}>
								<p className="ap-tagline">{g.role}</p>
								<p
									className="ap-body"
									style={{
										color: "var(--ap-ink-48)",
										marginTop: "var(--ap-xxs)",
										fontStyle: "italic",
									}}
								>
									“{g.question}”
								</p>
								<ul
									style={{
										marginTop: "var(--ap-md)",
										display: "grid",
										gap: "var(--ap-xs)",
										paddingLeft: "1.1em",
									}}
								>
									{g.items.map((item) => (
										<li className="ap-body" key={item}>
											{item}
										</li>
									))}
								</ul>
							</div>
						))}
					</div>

					<p
						className="ap-caption"
						style={{
							marginTop: "var(--ap-xl)",
							textAlign: "center",
							color: "var(--ap-ink-48)",
						}}
					>
						Also included: {ALSO.join(" · ")}
					</p>
				</div>
			</section>

			{/* ---- how it works ----------------------------------------- */}
			<section className="ap-tile ap-tile-dark" id="how">
				<div className="ap-inner">
					<h2 className="ap-display">From signing to running.</h2>
					<div
						style={{
							marginTop: "var(--ap-xxl)",
							display: "grid",
							gap: "var(--ap-xl)",
							gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
						}}
					>
						{STEPS.map((s, i) => (
							<div key={s.title}>
								<p
									className="ap-caption-strong"
									style={{ color: "var(--ap-primary-on-dark)" }}
								>
									Step {i + 1}
								</p>
								<p
									className="ap-tagline"
									style={{ marginTop: "var(--ap-xxs)" }}
								>
									{s.title}
								</p>
								<p
									className="ap-body"
									style={{
										marginTop: "var(--ap-xs)",
										color: "var(--ap-body-muted)",
									}}
								>
									{s.body}
								</p>
							</div>
						))}
					</div>
				</div>
			</section>

			{/* ---- the assistant ---------------------------------------- */}
			<section className="ap-tile ap-tile-light">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h2 className="ap-display">Ask the school a question.</h2>
					<p
						className="ap-lead-airy"
						style={{
							marginTop: "var(--ap-md)",
							color: "var(--ap-ink-80)",
							maxWidth: 720,
							marginInline: "auto",
						}}
					>
						“How much did we collect this week?” “Who was absent in Form 2
						today?” “Which parents still owe for this term?” The assistant reads
						the same permission-checked data you do — so a teacher never sees the
						finance answers a bursar sees.
					</p>
					<p
						className="ap-body"
						style={{
							marginTop: "var(--ap-md)",
							color: "var(--ap-ink-48)",
							maxWidth: 720,
							marginInline: "auto",
						}}
					>
						It never invents a figure: every number comes from the same reports
						that reconcile to the ledger. Anything that changes your data is
						only ever proposed — nothing happens until a person presses confirm.
					</p>
					<div style={{ marginTop: "var(--ap-xxl)" }}>
						<AppWindow
							alt="The ATLAS assistant answering a question about fee collection"
							caption="The assistant answers from the school's own data, and shows its source."
							needs="/assistant with a fee-collection question answered"
						/>
					</div>
				</div>
			</section>

			{/* ---- proof ------------------------------------------------ */}
			<section className="ap-tile ap-tile-parchment">
				<div className="ap-inner-wide">
					<h2 className="ap-display" style={{ textAlign: "center" }}>
						Real screens, not mock-ups.
					</h2>
					<div
						style={{
							marginTop: "var(--ap-xxl)",
							display: "grid",
							gap: "var(--ap-xl)",
							gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
						}}
					>
						<AppWindow
							alt="The debtors report, broken down class by class"
							caption="Debtors, class by class — and one button to send every reminder."
							height={1200}
							needs="/finance/debtors as a bursar"
							width={1900}
						/>
						<AppWindow
							alt="Marking attendance for a class"
							caption="Attendance for a whole stream, from a phone."
							height={1200}
							needs="/attendance with a class register open"
							width={1900}
						/>
						<AppWindow
							alt="A generated report card"
							caption="Report cards generated from the marks teachers already entered."
							height={1200}
							needs="/students/[id]/report-card with a published term"
							width={1900}
						/>
						<AppWindow
							alt="An invoice with payments recorded against it"
							caption="Every payment posts a balanced journal entry. Corrections are reversals."
							height={1200}
							needs="/finance/[id] invoice with payments"
							width={1900}
						/>
					</div>
					<p
						className="ap-caption"
						style={{
							marginTop: "var(--ap-xl)",
							textAlign: "center",
						}}
					>
						<Link className="ap-link" href="/tour">
							Look around on your own →
						</Link>
					</p>
				</div>
			</section>

			{/* ---- pricing ---------------------------------------------- */}
			<section className="ap-tile ap-tile-dark-2" id="pricing">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h2 className="ap-display">One price. Everything in it.</h2>
					<p
						className="ap-hero"
						style={{ marginTop: "var(--ap-lg)", fontSize: 48 }}
					>
						{fmtTZS(PRICE_TZS)}
					</p>
					<p className="ap-tagline" style={{ color: "var(--ap-body-muted)" }}>
						per year, for the whole school
					</p>

					<p
						className="ap-body"
						style={{
							marginTop: "var(--ap-lg)",
							color: "var(--ap-body-muted)",
							maxWidth: 620,
							marginInline: "auto",
						}}
					>
						A school with 500 students pays {fmtTZS(perStudentPerYear)} per
						student per year — about {fmtTZS(perStudentPerMonth)} per student per
						month, less than it costs to print their report cards. The{" "}
						{FREE_SMS.toLocaleString("en-US")} included SMS alone are roughly
						TZS 400,000 to 600,000 of messaging at market rates, so a meaningful
						part of the fee comes straight back as something you already pay for.
					</p>

					<ul
						style={{
							marginTop: "var(--ap-xxl)",
							display: "grid",
							gap: "var(--ap-xs)",
							gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
							listStyle: "none",
							padding: 0,
							textAlign: "left",
						}}
					>
						{INCLUSIONS.map((item) => (
							<li className="ap-body" key={item}>
								<span style={{ color: "var(--ap-primary-on-dark)" }}>✓ </span>
								{item}
							</li>
						))}
					</ul>

					<div style={{ marginTop: "var(--ap-xxl)" }}>
						<Link className="ap-btn" href="/anza">
							Book a demo
						</Link>
					</div>
				</div>
			</section>

			{/* ---- FAQ -------------------------------------------------- */}
			<section className="ap-tile ap-tile-light" id="faq">
				<div className="ap-inner">
					<h2 className="ap-display">Questions we actually get.</h2>
					<div
						style={{
							marginTop: "var(--ap-xl)",
							display: "grid",
							gap: "var(--ap-lg)",
						}}
					>
						{FAQ.map((f) => (
							<div
								key={f.q}
								style={{
									borderTop: "1px solid var(--ap-hairline)",
									paddingTop: "var(--ap-md)",
								}}
							>
								<h3 className="ap-body-strong">{f.q}</h3>
								<p
									className="ap-body"
									style={{
										marginTop: "var(--ap-xs)",
										color: "var(--ap-ink-80)",
									}}
								>
									{f.a}
								</p>
							</div>
						))}
					</div>
				</div>
			</section>

			{/* ---- close ------------------------------------------------ */}
			<section className="ap-tile ap-tile-parchment">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h2 className="ap-display">See it with your own school&apos;s numbers.</h2>
					<p
						className="ap-lead"
						style={{ marginTop: "var(--ap-md)", color: "var(--ap-ink-80)" }}
					>
						A demo takes about 30 minutes.
					</p>
					<div
						style={{
							display: "flex",
							gap: "var(--ap-sm)",
							justifyContent: "center",
							flexWrap: "wrap",
							marginTop: "var(--ap-xl)",
						}}
					>
						<Link className="ap-btn" href="/anza">
							Book a demo
						</Link>
						<Link className="ap-btn-ghost" href="/tour">
							Look around first
						</Link>
					</div>
				</div>
			</section>
		</>
	);
}
