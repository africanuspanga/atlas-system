/**
 * Panels that are drawn rather than photographed.
 *
 * Three slots on this site had no capture behind them and rendered a grey
 * "Screenshot pending" box on the live page. Two of them were never going to
 * be well served by a screenshot anyway: what a parent experiences is a text
 * message, not the screen that sent it, and what a teacher experiences is a
 * register on a phone. So those are drawn in the marketing system's own
 * materials, at the size the thing really is.
 *
 * These are examples, and each one says so in its caption. Nothing here is
 * presented as a captured screen — that is what <AppWindow> is for.
 */

function Caption({ children }: { children: React.ReactNode }) {
	return (
		<figcaption
			className="ap-caption"
			style={{
				marginTop: "var(--ap-sm)",
				color: "var(--ap-ink-48)",
				textAlign: "center",
			}}
		>
			{children}
		</figcaption>
	);
}

/**
 * The fee reminder, as the parent receives it. The page's signature object:
 * every parent of every student meets the product here and nowhere else.
 */
export function SmsPhone() {
	return (
		<figure style={{ margin: 0 }}>
			<div className="ap-phone">
				<div className="ap-phone-screen">
					<div className="ap-phone-head">
						<p className="ap-caption-strong">CHIEFSARWATT</p>
						<p className="ap-fine" style={{ marginTop: 2 }}>
							Text message
						</p>
					</div>

					<p className="ap-sms-meta">Mon 07:31</p>
					<p className="ap-sms">
						Chief Sarwatt School: Neema Mushi (Form 2A) has a fee balance of TZS
						340,000 for Term 2. Paid so far: TZS 560,000. Receipts are in the
						parent portal.
					</p>

					<p className="ap-sms-meta" style={{ marginTop: "var(--ap-xs)" }}>
						Tue 09:04
					</p>
					<p className="ap-sms">
						Chief Sarwatt School: Neema Mushi was marked absent today, 2
						September. Please contact the class teacher.
					</p>
				</div>
			</div>
			<Caption>
				Every parent gets their own child&apos;s figures. Nobody sees anybody
				else&apos;s.
			</Caption>
		</figure>
	);
}

const REGISTER = [
	{ name: "Amina Kimaro", present: true },
	{ name: "Baraka Mollel", present: true },
	{ name: "Doreen Massawe", present: false },
	{ name: "Emmanuel Shirima", present: true },
	{ name: "Neema Mushi", present: false },
	{ name: "Rehema Laizer", present: true },
];

/** Attendance as a teacher takes it: on a phone, standing in front of a class. */
export function RegisterPhone() {
	return (
		<figure style={{ margin: 0 }}>
			<div className="ap-phone">
				<div className="ap-phone-screen">
					<div className="ap-phone-head">
						<p className="ap-caption-strong">Form 2A</p>
						<p className="ap-fine" style={{ marginTop: 2 }}>
							Attendance, Wednesday 2 September
						</p>
					</div>

					<div>
						{REGISTER.map((s) => (
							<div className="ap-row" key={s.name}>
								<span>{s.name}</span>
								<span
									className={s.present ? "ap-pill-present" : "ap-pill-absent"}
								>
									{s.present ? "PRESENT" : "ABSENT"}
								</span>
							</div>
						))}
					</div>

					<p
						className="ap-fine"
						style={{ marginTop: "auto", paddingTop: "var(--ap-sm)" }}
					>
						Saving the register texts the guardians of the two absent students.
					</p>
				</div>
			</div>
			<Caption>
				A whole stream in one pass, from the phone already in their pocket.
			</Caption>
		</figure>
	);
}

/**
 * The assistant, as a conversation. The point of the section is not what the
 * screen looks like but that the answer carries its own provenance, so the
 * panel shows the question, the figure and where the figure came from.
 */
export function AssistantPanel() {
	return (
		<figure style={{ margin: 0 }}>
			<div className="ap-convo">
				<p className="ap-convo-q">How much did we collect this week?</p>
				<div className="ap-convo-a">
					<span className="ap-convo-figure">TZS 18,450,000</span>
					collected from Monday to today, across 71 receipts. M-Pesa accounted
					for TZS 11,200,000 of that.
					<div className="ap-sources">
						<span className="ap-source">Fee collection report</span>
						<span className="ap-source">Term 2, 2026</span>
						<span className="ap-source">Reconciled to ledger</span>
					</div>
				</div>
			</div>
			<Caption>
				Figures come from the finance reports, never from the model&apos;s own
				arithmetic.
			</Caption>
		</figure>
	);
}
