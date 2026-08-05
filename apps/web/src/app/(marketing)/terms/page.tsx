import type { Metadata } from "next";
import {
	FREE_FEATURE_REQUESTS,
	FREE_SMS,
	PRICE_TZS,
	fmtTZS,
} from "@/lib/offer";
import { LegalFooterNav, LegalHeader, Todo } from "../_components/legal";

export const metadata: Metadata = {
	title: "Terms of service",
	description:
		"The terms on which a school uses ATLAS: the annual fee, what is included, what happens at renewal, and what happens to your data if you stop paying.",
	alternates: { canonical: "/terms" },
	robots: { index: true, follow: true },
};

export default function TermsPage() {
	return (
		<section className="ap-tile ap-tile-light">
			<div className="ap-inner">
				<LegalHeader
					page="agreement"
					title="Terms of service"
					updated="5 August 2026"
				/>

				<div className="ap-legal">
					<p>
						These terms govern your school&apos;s use of ATLAS. They are between{" "}
						<Todo>registered entity name</Todo>, a company registered in
						Tanzania under number <Todo>company registration number</Todo> of{" "}
						<Todo>registered address</Todo> (&ldquo;ATLAS&rdquo;,
						&ldquo;we&rdquo;), and the school that subscribes
						(&ldquo;you&rdquo;).
					</p>

					<h2>1. What you are buying</h2>
					<p>
						ATLAS is a school management system covering admissions and student
						records, classes and timetables, attendance, assessments and report
						cards, fees and accounting, payroll, communications with parents, an
						AI assistant, and the operational modules listed on our website at
						the time you subscribe.
					</p>
					<p>
						The fee is <strong>{fmtTZS(PRICE_TZS)} per year</strong> for the
						whole school. There is one price for every school and there are no
						tiers. It includes:
					</p>
					<ul>
						<li>
							All modules, for every role — head teacher, accountant, teachers
							and parents.
						</li>
						<li>
							{FREE_SMS.toLocaleString("en-US")} SMS during the subscription
							year, for fee reminders, attendance alerts and results.
						</li>
						<li>The AI assistant.</li>
						<li>
							Up to {FREE_FEATURE_REQUESTS} custom feature requests, tracked as
							a ledger you can see, so there is no disagreement later about what
							was promised.
						</li>
						<li>
							Unlimited students, staff, classes and streams; the parent portal;
							import of your existing spreadsheets; training and onboarding; and
							every update released during your year.
						</li>
					</ul>

					<h2>2. Payment and setup</h2>
					<p>
						The fee is payable annually in advance, by bank transfer or M-Pesa.{" "}
						<strong>Setup begins when payment clears.</strong> We say this at
						the point of sale so it is never a surprise.
					</p>
					<p>
						Your subscription period runs for twelve months from the date we
						confirm your workspace is ready.
					</p>

					<h2>3. SMS allowance</h2>
					<p>
						Your annual subscription includes{" "}
						{FREE_SMS.toLocaleString("en-US")} messages for the subscription
						year. You can see how many you have used and how many remain in the
						admin screens, and we warn you at 80%.
					</p>
					<p>
						<strong>You can buy additional SMS at any time.</strong> Extra
						bundles are purchased separately from the subscription, at{" "}
						<Todo>price per bundle and bundle sizes</Todo>, and are added to
						your remaining balance. Bought messages are used only once the
						included allowance is exhausted.
					</p>
					<p>
						If your balance reaches zero and no bundle has been bought, further
						messages are blocked rather than billed automatically, and the
						school is told. We do this deliberately: a message that fails
						silently would be a fee reminder, and a school should never discover
						that only from an angry parent.
					</p>

					<h2>4. Renewal, expiry, and what happens to your data</h2>
					<p>
						We will contact you before your period ends to arrange renewal. If
						renewal is not completed by the end of the period, your subscription
						enters a grace period of <Todo>7–14 — pick one</Todo> days during
						which nothing changes. Schools&apos; payment approvals genuinely take
						this long.
					</p>
					<p>After the grace period, and until you renew:</p>
					<ul>
						<li>
							<strong>Your access becomes read-only.</strong> You can still open
							the system, read every record and export your data. You cannot
							record new payments, marks or attendance.
						</li>
						<li>
							<strong>
								Parents keep full access to fee and results history regardless.
							</strong>{" "}
							Their access is never restricted because of a school&apos;s unpaid
							invoice.
						</li>
						<li>
							<strong>We never delete your data for non-payment.</strong> There
							is no hard lockout and no deletion. Your records remain yours.
						</li>
					</ul>
					<p>
						If you choose to leave, we will provide a complete export of your
						data in a usable format. We will delete your data on written request
						from a person authorised by the school, subject to any records we
						are required by law to retain.
					</p>

					<h2>5. Your data and your responsibilities</h2>
					<p>
						<strong>Your school&apos;s data belongs to your school.</strong> We
						process it to provide the service, on your instructions, as
						described in our <a className="ap-link" href="/privacy">privacy notice</a>.
					</p>
					<p>You are responsible for:</p>
					<ul>
						<li>
							The accuracy of the records you enter, including fee balances
							carried forward from your previous system. We reconcile the
							imported total against your own figure and ask your bursar to sign
							it off before anything is relied upon.
						</li>
						<li>
							Who you invite and what role you give them. Each person sets their
							own password; shared logins are not permitted, because an audit
							trail that cannot identify a person is not an audit trail.
						</li>
						<li>
							Having a lawful basis to hold and share the personal data of your
							students, their guardians and your staff, and for the messages you
							choose to send to parents through ATLAS.
						</li>
					</ul>

					<h2>6. Availability and support</h2>
					<p>
						We aim to keep ATLAS available during Tanzanian school hours and to
						give reasonable notice of planned maintenance. We do not currently
						offer a contractual uptime guarantee; if you need one, it must be
						agreed separately in writing.
					</p>
					<p>
						Support is available at <Todo>support channel and hours</Todo>. We
						check in with every school at 30 days and once per term.
					</p>

					<h2>7. Custom features</h2>
					<p>
						Your {FREE_FEATURE_REQUESTS} included feature requests cover changes
						that fit how your school works within the existing product. They do
						not cover integrations with third-party systems, bespoke hardware, or
						work that would change the product for every other school in a way we
						judge unsuitable. We will tell you which category a request falls
						into before work starts, and the ledger records the outcome either
						way.
					</p>

					<h2>8. Liability</h2>
					<p>
						Nothing in these terms limits liability that cannot lawfully be
						limited. Subject to that, our total liability in any twelve-month
						period is limited to the fees you paid in that period.
					</p>
					<p>
						ATLAS produces financial and statutory figures from the data you
						enter. It is a tool, not an accountant: payroll settings including
						PAYE bands must be verified by a qualified Tanzanian accountant
						before a payroll run is posted, and the system deliberately blocks
						unverified settings.
					</p>

					<h2>9. Suspension</h2>
					<p>
						We may suspend access where required by law, or where use of the
						service threatens the security or integrity of the platform or
						another school&apos;s data. We will tell you why, and restore access
						as soon as the cause is resolved. Suspension is not deletion.
					</p>

					<h2>10. Changes</h2>
					<p>
						We may update these terms. If a change materially reduces what you
						receive, we will tell you at least 30 days before it takes effect,
						and it will not apply until your next renewal.
					</p>

					<h2>11. Governing law</h2>
					<p>
						These terms are governed by the laws of the United Republic of
						Tanzania, and the courts of Tanzania have exclusive jurisdiction.
					</p>

					<h2>12. Contact</h2>
					<p>
						<Todo>contact email</Todo> · <Todo>phone</Todo> ·{" "}
						<Todo>postal address</Todo>
					</p>
				</div>

				<LegalFooterNav other="privacy" />
			</div>
		</section>
	);
}
