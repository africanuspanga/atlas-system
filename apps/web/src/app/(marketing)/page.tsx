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
import { ALSO, FAQ, PROBLEMS, STEPS } from "./_components/content";
import { BENTO, PILLARS } from "./_components/pillars";
import { RoleSwitcher } from "./_components/role-switcher";
import { AppWindow } from "./_components/shot";

/**
 * The landing page.
 *
 * Tile rhythm alternates light / parchment / near-black, and the surface
 * change is the only section divider — there are no rules or borders between
 * bands. Sections are labelled with a monospace eyebrow: ATLAS is a system of
 * record, so the utility face carries section identity.
 *
 * Price and inclusions render from lib/offer.ts, and the JSON-LD is generated
 * from the same constants, so the structured data cannot advertise a price the
 * visible page has stopped showing.
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
							maxWidth: 660,
							marginInline: "auto",
						}}
					>
						Fees and arrears, attendance, marks and report cards, and the
						messages that go to parents.
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
							height={675}
							priority
							src="/screenshots/dashboard.png"
							width={1568}
						/>
					</div>
				</div>
			</section>

			{/* ---- the offer, stated plainly ---------------------------- */}
			<section
				className="ap-tile ap-tile-parchment"
				style={{ paddingBlock: "var(--ap-xxl)" }}
			>
				<div
					className="ap-inner-wide"
					style={{
						display: "flex",
						flexWrap: "wrap",
						justifyContent: "center",
						gap: "var(--ap-lg) var(--ap-xxl)",
					}}
				>
					{[
						`${fmtTZS(PRICE_TZS)} a year`,
						`${FREE_SMS.toLocaleString("en-US")} SMS included`,
						"Unlimited students",
						"One price, no tiers",
					].map((item) => (
						<span className="ap-eyebrow" key={item}>
							{item}
						</span>
					))}
				</div>
			</section>

			{/* ---- what it is ------------------------------------------- */}
			<section className="ap-tile ap-tile-light">
				<div className="ap-inner-wide">
					<div className="ap-head">
						<div>
							<p className="ap-eyebrow">The platform</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								Built for how a school
								<br />
								actually runs.
							</h2>
						</div>
						<p className="ap-body" style={{ color: "var(--ap-ink-80)" }}>
							Not a filing cabinet with a login. The information a school
							already keeps, connected — so a payment, a balance and a term&apos;s
							collection figure are the same fact seen from different angles.
						</p>
					</div>

					<div className="ap-grid-4" style={{ marginTop: "var(--ap-xxl)" }}>
						{PILLARS.map((p) => (
							<Link className="ap-feature" href={p.href} key={p.title}>
								<p className="ap-tagline">{p.title}</p>
								<p
									className="ap-caption"
									style={{
										marginTop: "var(--ap-xs)",
										color: "var(--ap-ink-80)",
									}}
								>
									{p.body}
								</p>
								<span aria-hidden="true" className="ap-feature-arrow">
									→
								</span>
							</Link>
						))}
					</div>
				</div>
			</section>

			{/* ---- SIGNATURE: four people, four questions --------------- */}
			<section className="ap-tile ap-tile-parchment" id="roles">
				<div className="ap-inner-wide">
					<div style={{ textAlign: "center" }}>
						<p className="ap-eyebrow">Solutions by role</p>
						<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
							Four people. Four questions.
						</h2>
						<p
							className="ap-body"
							style={{
								marginTop: "var(--ap-sm)",
								color: "var(--ap-ink-80)",
								maxWidth: 620,
								marginInline: "auto",
							}}
						>
							Nobody buys &ldquo;a school system&rdquo;. Each of these four
							people is buying an answer to their own question. Pick yours.
						</p>
					</div>

					<div style={{ marginTop: "var(--ap-xxl)" }}>
						<RoleSwitcher />
					</div>

					<p
						className="ap-caption"
						style={{
							marginTop: "var(--ap-xxl)",
							textAlign: "center",
							color: "var(--ap-ink-48)",
						}}
					>
						Also included: {ALSO.join(" · ")}
					</p>
				</div>
			</section>

			{/* ---- the problem ------------------------------------------ */}
			<section className="ap-tile ap-tile-dark">
				<div className="ap-inner-wide">
					<div className="ap-head">
						<div>
							<p className="ap-eyebrow">Why schools move</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								What a term
								<br />
								actually looks like.
							</h2>
						</div>
						<p className="ap-body" style={{ color: "var(--ap-body-muted)" }}>
							None of this is a discipline problem. It is one structural
							problem wearing six costumes: the school&apos;s information lives
							in places that cannot be added together.
						</p>
					</div>

					<ul
						className="ap-grid-3"
						style={{ marginTop: "var(--ap-xxl)", listStyle: "none", padding: 0 }}
					>
						{PROBLEMS.map((p) => (
							<li
								className="ap-body"
								key={p}
								style={{
									color: "var(--ap-body-muted)",
									borderTop: "1px solid rgba(255,255,255,0.14)",
									paddingTop: "var(--ap-md)",
								}}
							>
								{p}
							</li>
						))}
					</ul>
				</div>
			</section>

			{/* ---- fees ------------------------------------------------- */}
			<section className="ap-tile ap-tile-light" id="fees">
				<div className="ap-inner-wide">
					<div className="ap-split">
						<div>
							<p className="ap-eyebrow">Fees and arrears</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								Arrears are a list, not a figure.
							</h2>
							<p
								className="ap-body"
								style={{
									marginTop: "var(--ap-md)",
									color: "var(--ap-ink-80)",
								}}
							>
								A school cannot chase a total. It can only chase people. Once
								the list exists and is correct, collection stops being a
								project and becomes a routine.
							</p>
							<ul className="ap-check" style={{ marginTop: "var(--ap-lg)" }}>
								<li className="ap-body">
									Every student with a balance, grouped by class
								</li>
								<li className="ap-body">
									Reminders sent automatically, each parent getting their own
									child&apos;s figure
								</li>
								<li className="ap-body">
									Bank, M-Pesa and cash reconciled against the same ledger
								</li>
								<li className="ap-body">
									Receipts the parent can see for themselves
								</li>
							</ul>
						</div>
						<AppWindow
							alt="The debtors report, class by class"
							caption="Debtors, class by class — and one button to remind them all."
							height={675}
							src="/screenshots/debtors.png"
							width={1568}
						/>
					</div>
				</div>
			</section>

			{/* ---- assistant -------------------------------------------- */}
			<section className="ap-tile ap-tile-parchment" id="assistant">
				<div className="ap-inner-wide">
					<div className="ap-split ap-split-reverse">
						<div>
							<p className="ap-eyebrow">The assistant</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								Ask the school a question.
							</h2>
							<p
								className="ap-body"
								style={{ marginTop: "var(--ap-md)", color: "var(--ap-ink-80)" }}
							>
								&ldquo;How much did we collect this week?&rdquo; &ldquo;Who was
								absent in Form 2 today?&rdquo; Answers come from the school&apos;s
								own records, not from a summary of the page you are looking at.
							</p>
							<ul className="ap-check" style={{ marginTop: "var(--ap-lg)" }}>
								<li className="ap-body">
									It sees exactly what your role permits — a teacher asking a
									finance question does not get a finance answer
								</li>
								<li className="ap-body">
									It never computes money itself; figures come from the reports
									that reconcile to the ledger
								</li>
								<li className="ap-body">
									Anything that changes data is proposed, never done. A person
									presses confirm
								</li>
							</ul>
						</div>
						<AppWindow
							alt="The ATLAS assistant answering a question about fee collection"
							caption="It shows where the answer came from."
							height={1200}
							needs="/assistant with a fee-collection question answered"
							width={1900}
						/>
					</div>
				</div>
			</section>

			{/* ---- what is included ------------------------------------- */}
			<section className="ap-tile ap-tile-light">
				<div className="ap-inner-wide">
					<div className="ap-head">
						<div>
							<p className="ap-eyebrow">What you get</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								Everything, for one price.
							</h2>
						</div>
						<p className="ap-body" style={{ color: "var(--ap-ink-80)" }}>
							Every line below is in the product today. Nothing here is coming
							soon, and nothing is a paid add-on.
						</p>
					</div>

					<div className="ap-bento" style={{ marginTop: "var(--ap-xxl)" }}>
						{BENTO.map((tile) => (
							<div
								className={`ap-card${tile.wide ? " ap-span-3" : ""}`}
								key={tile.label}
								style={
									tile.dark
										? {
												background: "var(--ap-tile-1)",
												borderColor: "transparent",
												color: "var(--ap-on-dark)",
											}
										: undefined
								}
							>
								{tile.figure ? (
									<p
										className="ap-figure"
										style={{ color: "var(--ap-primary)" }}
									>
										{tile.figure}
									</p>
								) : null}
								<p
									className="ap-body-strong"
									style={{ marginTop: tile.figure ? "var(--ap-xs)" : 0 }}
								>
									{tile.label}
								</p>
								{tile.body ? (
									<p
										className="ap-caption"
										style={{
											marginTop: "var(--ap-xxs)",
											color: tile.dark
												? "var(--ap-body-muted)"
												: "var(--ap-ink-48)",
										}}
									>
										{tile.body}
									</p>
								) : null}
							</div>
						))}
					</div>
				</div>
			</section>

			{/* ---- how it works ----------------------------------------- */}
			<section className="ap-tile ap-tile-parchment" id="how">
				<div className="ap-inner-wide">
					<div className="ap-head">
						<div>
							<p className="ap-eyebrow">Onboarding</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								From signing to running.
							</h2>
						</div>
						<p className="ap-body" style={{ color: "var(--ap-ink-80)" }}>
							These four happen in this order for a reason — parent SMS goes on
							last, after balances are verified.
						</p>
					</div>

					<ol
						style={{
							marginTop: "var(--ap-xxl)",
							display: "grid",
							gap: "var(--ap-lg)",
							gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
							listStyle: "none",
							padding: 0,
							counterReset: "step",
						}}
					>
						{STEPS.map((s, i) => (
							<li
								key={s.title}
								style={{
									borderTop: "1px solid var(--ap-hairline)",
									paddingTop: "var(--ap-md)",
								}}
							>
								<span
									className="ap-eyebrow"
									style={{ color: "var(--ap-primary)" }}
								>
									Step {i + 1}
								</span>
								<p className="ap-tagline" style={{ marginTop: "var(--ap-xs)" }}>
									{s.title}
								</p>
								<p
									className="ap-caption"
									style={{
										marginTop: "var(--ap-xs)",
										color: "var(--ap-ink-80)",
									}}
								>
									{s.body}
								</p>
							</li>
						))}
					</ol>
				</div>
			</section>

			{/* ---- pricing ---------------------------------------------- */}
			<section className="ap-tile ap-tile-dark-2" id="pricing">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<p className="ap-eyebrow">Pricing</p>
					<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
						One price. Everything in it.
					</h2>
					<p
						className="ap-figure"
						style={{ fontSize: 56, marginTop: "var(--ap-lg)" }}
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
						student per year — about {fmtTZS(perStudentPerMonth)} a month, less
						than it costs to print their report cards.
					</p>

					<ul
						className="ap-check"
						style={{
							marginTop: "var(--ap-xxl)",
							textAlign: "left",
							gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
							display: "grid",
						}}
					>
						{INCLUSIONS.map((item) => (
							<li className="ap-body" key={item}>
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
				<div className="ap-inner-wide">
					<div className="ap-head">
						<div>
							<p className="ap-eyebrow">Questions</p>
							<h2 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
								The ones we actually get.
							</h2>
						</div>
					</div>

					<div
						style={{
							marginTop: "var(--ap-xl)",
							display: "grid",
							gap: "var(--ap-lg)",
							gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
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
			<section className="ap-tile ap-tile-dark-3">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h2 className="ap-hero">Start with your own numbers.</h2>
					<p
						className="ap-lead"
						style={{
							marginTop: "var(--ap-md)",
							color: "var(--ap-body-muted)",
							maxWidth: 560,
							marginInline: "auto",
						}}
					>
						A demo takes about 30 minutes. Bring last term&apos;s fee register.
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
					<div style={{ marginTop: "var(--ap-xxl)" }}>
						<AppWindow
							alt="ATLAS running a school day"
							height={675}
							src="/screenshots/dashboard.png"
							width={1568}
						/>
					</div>
				</div>
			</section>
		</>
	);
}
