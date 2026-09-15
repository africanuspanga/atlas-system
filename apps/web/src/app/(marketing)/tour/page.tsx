import type { Metadata } from "next";
import Link from "next/link";
import {
	AssistantPanel,
	RegisterPhone,
	SmsPhone,
} from "../_components/panels";
import { AppWindow } from "../_components/shot";

/**
 * The no-login tour — the "look around on my own" path.
 *
 * Deliberately a scrollable page of real screenshots rather than shared demo
 * credentials. On the sibling product a security review had to remove exactly
 * that, because anyone holding the credentials could drain the demo tenant's
 * SMS balance and export real personal data. For ATLAS the exposure is worse:
 * a demo tenant holds children's names, parents' phone numbers and fee
 * records. A per-visitor expiring demo tenant with SMS and export disabled is
 * the right long-term answer; this has no abuse surface at all.
 */
export const metadata: Metadata = {
	title: "Take a look around",
	description:
		"Real ATLAS screens, with a caption each. No sign-in, no commitment.",
	alternates: { canonical: "/tour" },
};

const STOPS = [
	{
		title: "The dashboard",
		body: "Today's attendance, this month's collections and what is still outstanding. The screen a head teacher answers a board question from.",
		alt: "The ATLAS dashboard",
		src: "/screenshots/dashboard.png",
	},
	{
		title: "Debtors, class by class",
		body: "Every student with a balance, grouped by class. Reminders go out from the same screen, each parent getting their own child's figure.",
		alt: "The debtors report",
		src: "/screenshots/debtors.png",
	},
	{
		title: "Every student, in one list",
		body: "Admission numbers, class, guardian and status, all searchable. Report cards are generated from here.",
		alt: "The student register",
		src: "/screenshots/students.png",
	},
	{
		title: "An invoice and its payments",
		body: "Bank, M-Pesa and cash all land here. Records are immutable: a correction is a reversal, and every movement posts a balanced journal entry.",
		alt: "An invoice with payments",
		needs: "/finance/[id] invoice with payments recorded",
	},
	{
		title: "Attendance",
		body: "A whole stream marked in one pass, from a phone or a laptop. Guardians of absent students get an SMS.",
		alt: "Marking class attendance",
		panel: "register",
	},
	{
		title: "Marks and report cards",
		body: "Continuous assessment and exam marks go in during the term. Grading is a rule the system applies, so report cards are a review job rather than a data-entry job.",
		alt: "A generated report card",
		needs: "/students/[id]/report-card with a published term",
	},
	{
		title: "The assistant",
		body: "Ask in plain language. It reads only what your role permits, never computes money itself, and can only propose changes for a person to confirm.",
		alt: "The ATLAS assistant",
		panel: "assistant",
	},
	{
		title: "The parent portal",
		body: "Fee balance, payment history with receipts, attendance and results, on the web and on the phone. What most parents actually see is the SMS.",
		alt: "The parent portal",
		panel: "sms",
	},
] as const;

/**
 * The three stops a screenshot would misrepresent: a teacher marks a register
 * on a phone, and a parent only ever meets ATLAS as a text message. Drawn
 * rather than captured, in the same panels the landing page uses.
 */
const PANELS: Record<string, React.ReactNode> = {
	register: <RegisterPhone />,
	sms: <SmsPhone />,
	assistant: <AssistantPanel />,
};

export default function TourPage() {
	return (
		<>
			<section className="ap-tile ap-tile-light">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h1 className="ap-hero">Take a look around.</h1>
					<p
						className="ap-lead"
						style={{
							marginTop: "var(--ap-md)",
							color: "var(--ap-ink-80)",
							maxWidth: 680,
							marginInline: "auto",
						}}
					>
						Real screens from the product, with a caption each. No sign-in and
						nothing to fill in.
					</p>
				</div>
			</section>

			{STOPS.map((stop, i) => (
				<section
					className={`ap-tile ${i % 2 === 0 ? "ap-tile-parchment" : "ap-tile-light"}`}
					key={stop.title}
				>
					<div className="ap-inner">
						<h2 className="ap-display-md">{stop.title}</h2>
						<p
							className="ap-body"
							style={{
								marginTop: "var(--ap-xs)",
								color: "var(--ap-ink-80)",
								maxWidth: 680,
							}}
						>
							{stop.body}
						</p>
						<div style={{ marginTop: "var(--ap-xl)" }}>
							{"panel" in stop ? (
								PANELS[stop.panel]
							) : (
								<AppWindow
									alt={stop.alt}
									height={"src" in stop && stop.src ? 675 : 1200}
									needs={"needs" in stop ? stop.needs : undefined}
									priority={i === 0}
									src={"src" in stop ? stop.src : undefined}
									width={"src" in stop && stop.src ? 1568 : 1900}
								/>
							)}
						</div>
					</div>
				</section>
			))}

			<section className="ap-tile ap-tile-dark">
				<div className="ap-inner" style={{ textAlign: "center" }}>
					<h2 className="ap-display">Seen enough?</h2>
					<p
						className="ap-lead"
						style={{ marginTop: "var(--ap-md)", color: "var(--ap-body-muted)" }}
					>
						A demo takes about 30 minutes, with your own school&apos;s numbers.
					</p>
					<div style={{ marginTop: "var(--ap-xl)" }}>
						<Link className="ap-btn" href="/anza">
							Book a demo
						</Link>
					</div>
				</div>
			</section>
		</>
	);
}
