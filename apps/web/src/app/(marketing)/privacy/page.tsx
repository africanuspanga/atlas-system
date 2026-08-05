import type { Metadata } from "next";
import { LegalFooterNav, LegalHeader, Todo } from "../_components/legal";

export const metadata: Metadata = {
	title: "Privacy notice",
	description:
		"What personal data ATLAS holds on behalf of a school, who processes it, where it goes, and the rights of students, guardians and staff.",
	alternates: { canonical: "/privacy" },
	robots: { index: true, follow: true },
};

/**
 * Sub-processors, taken from the services the product actually calls.
 * Regions are unknown until the owner confirms each contract — they are
 * deliberately not guessed here, because a wrong region on a published notice
 * is worse than an admitted gap.
 */
const SUBPROCESSORS = [
	{
		name: "Supabase",
		purpose: "Database, authentication and file storage",
		data: "All school records",
	},
	{
		name: "Beem Africa",
		purpose: "Sending SMS to guardians and staff",
		data: "Recipient phone number and message text",
	},
	{
		name: "Moonshot AI",
		purpose: "The AI assistant's language model",
		data: "The question asked and the tool results returned to answer it",
	},
	{
		name: "Sentry",
		purpose: "Error reporting, so faults are found and fixed",
		data: "Technical diagnostics; 5xx responses are scrubbed",
	},
	{
		name: "Redis",
		purpose: "Background job queueing",
		data: "Job references, not record content",
	},
	{
		name: "Expo",
		purpose: "Mobile app delivery and push notifications",
		data: "Device push tokens",
	},
	{
		name: "Resend",
		purpose: "Transactional and sales email",
		data: "Email address and message content",
	},
];

export default function PrivacyPage() {
	return (
		<section className="ap-tile ap-tile-light">
			<div className="ap-inner">
				<LegalHeader
					page="notice"
					title="Privacy notice"
					updated="5 August 2026"
				/>

				<div className="ap-legal">
					<p>
						ATLAS holds information about children. We have written this notice
						to be read, not to be survived, and it describes what the software
						actually does rather than what would be convenient to claim.
					</p>

					<h2>1. Who is responsible for what</h2>
					<p>
						Your <strong>school</strong>{" "}
						decides what records to keep about its
						students, guardians and staff, and why. In the language of
						Tanzania&apos;s Personal Data Protection Act 2022, the school is the{" "}
						<strong>data controller</strong>.
					</p>
					<p>
						<strong>ATLAS</strong>{" "}
						stores and processes those records on the
						school&apos;s instructions in order to provide the service — the{" "}
						<strong>data processor</strong>. We do not sell personal data, we do
						not use it to train AI models, and we do not use children&apos;s data
						for marketing.
					</p>
					<p>
						For our own website, the enquiry form and our business contacts, we
						are the controller.
					</p>

					<h2>2. What we hold, on behalf of your school</h2>
					<table>
						<thead>
							<tr>
								<th>Category</th>
								<th>Examples</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>Student identity</td>
								<td>
									Name, admission number, date of birth, class and stream,
									enrolment status
								</td>
							</tr>
							<tr>
								<td>Guardians</td>
								<td>Name, relationship, phone number, portal access</td>
							</tr>
							<tr>
								<td>Attendance</td>
								<td>Daily and per-period presence and absence</td>
							</tr>
							<tr>
								<td>Academic</td>
								<td>
									Assessment marks, grades, report cards, NECTA combinations
								</td>
							</tr>
							<tr>
								<td>Fees and accounting</td>
								<td>
									Invoices, payments, receipts, balances, ledger entries
								</td>
							</tr>
							<tr>
								<td>Staff and payroll</td>
								<td>Employment records, salaries, PAYE and deductions</td>
							</tr>
							<tr>
								<td>Communications</td>
								<td>SMS and announcements sent, and their delivery status</td>
							</tr>
							<tr>
								<td>Health</td>
								<td>
									Limited clinic visit records, where the school uses that
									module
								</td>
							</tr>
							<tr>
								<td>Technical</td>
								<td>
									Sign-in records, audit logs of who changed what, device push
									tokens
								</td>
							</tr>
						</tbody>
					</table>

					<h2>3. Children&apos;s data</h2>
					<p>
						Most of what ATLAS holds concerns children, which is why access is
						restricted by role rather than by trust. A teacher sees their own
						classes. A bursar sees fees. A parent sees only their own children.
						Every one of these boundaries is enforced by the database itself, not
						only by the screens.
					</p>
					<p>
						Clinic messages sent to guardians are deliberately kept general, and
						clinical detail is never sent to the AI assistant.
					</p>

					<h2>4. The AI assistant</h2>
					<p>
						When someone at your school asks the assistant a question, the
						question and the results of the specific lookups needed to answer it
						are sent to our model provider, <strong>Moonshot AI</strong>, whose
						service is <strong>outside Tanzania</strong>.
					</p>
					<p>By design, the assistant:</p>
					<ul>
						<li>
							reaches data only through a fixed catalogue of tools, each
							permission-checked against the asking user&apos;s role;
						</li>
						<li>
							receives <strong>no clinical detail and no individual salary</strong>{" "}
							— the payroll tool returns aggregates only;
						</li>
						<li>
							cannot change anything on its own. Every write is proposed and
							waits for a person to confirm it.
						</li>
					</ul>
					<p>
						<strong>
							Transferring personal data outside Tanzania may require approval
							or a permit from the Personal Data Protection Commission.
						</strong>{" "}
						That work is not complete. Until it is, the assistant must not be
						enabled against real student data — it is restricted to pilot and
						synthetic data. Your onboarding will tell you plainly which applies
						to your school.
					</p>

					<h2>5. Who else processes data</h2>
					<p>
						We use the following sub-processors. The country or region of each
						service, and the contract with it, are being confirmed and will be
						listed here before any school goes live:{" "}
						<Todo>confirm region and contract per row</Todo>.
					</p>
					<table>
						<thead>
							<tr>
								<th>Service</th>
								<th>Purpose</th>
								<th>Data</th>
							</tr>
						</thead>
						<tbody>
							{SUBPROCESSORS.map((s) => (
								<tr key={s.name}>
									<td>{s.name}</td>
									<td>{s.purpose}</td>
									<td>{s.data}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p>
						We will tell schools before adding a sub-processor that handles
						student data.
					</p>

					<h2>6. How long we keep it</h2>
					<p>
						While your school subscribes, we keep records for as long as the
						school needs them — a student&apos;s results and fee history are
						meant to outlast their time at the school.
					</p>
					<p>
						<strong>We do not delete a school&apos;s data for non-payment.</strong>{" "}
						On leaving, we provide a full export and delete on written request
						from an authorised person, except where law requires us to retain
						something.
					</p>
					<p>
						Specific retention periods for assistant conversation history, audit
						logs and message records are being finalised with counsel:{" "}
						<Todo>retention schedule per category</Todo>.
					</p>

					<h2>7. Rights of students, guardians and staff</h2>
					<p>
						Under the Personal Data Protection Act 2022 you may ask to see the
						data held about you, to have it corrected, to object to certain
						processing, and to complain to the Personal Data Protection
						Commission.
					</p>
					<p>
						Because your school is the controller,{" "}
						<strong>please contact your school first</strong> — they hold the
						records and can correct them directly. If you cannot resolve it with
						the school, contact us at <Todo>privacy contact email</Todo> and we
						will help the school respond.
					</p>

					<h2>8. Security</h2>
					<p>
						Access is separated by school and by role, and enforced in the
						database as well as the application. Financial records cannot be
						edited — a correction is a reversal — so the audit trail cannot be
						quietly rewritten. Every change of consequence is logged against the
						person who made it. Passwords are set by each user and never shared
						with us.
					</p>
					<p>
						If a breach occurs that is likely to affect people, we will notify
						the school and the Commission as required, following our internal
						incident-response procedure.
					</p>

					<h2>9. This website</h2>
					<p>
						The public website sets no advertising or analytics cookies. If you
						submit the demo enquiry form we store what you enter — your school,
						your name and your phone number — in order to contact you about
						ATLAS, and for no other purpose. We do not sell it or share it with
						anyone outside our sub-processors above.
					</p>

					<h2>10. Registration and contact</h2>
					<p>
						Our registration with the Personal Data Protection Commission and
						our data-protection contact are being completed:{" "}
						<Todo>PDPC registration reference</Todo> ·{" "}
						<Todo>DPO or privacy contact name and email</Todo>.
					</p>
					<p>
						<Todo>registered entity name</Todo> ·{" "}
						<Todo>registered address</Todo>
					</p>
				</div>

				<LegalFooterNav other="terms" />
			</div>
		</section>
	);
}
