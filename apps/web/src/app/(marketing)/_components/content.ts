/**
 * Landing-page content, kept out of the JSX so the FAQ can feed both the
 * visible page and the FAQPage structured data from ONE source. Google
 * penalises structured data that does not match the visible text, and the only
 * reliable way to keep them identical is to never write them twice.
 *
 * Every module listed here was verified against the code before it went on the
 * page. A module on the landing page that is not in the product is a refund
 * conversation later. Deliberately ABSENT because they do not exist yet:
 * discipline/incident records, and TAMISEMI-format reporting.
 */

export const PROBLEMS: readonly string[] = [
	"Fees live in an exercise book or a spreadsheet, and nobody knows total arrears until the term is nearly over.",
	"A parent says they paid, and there is no receipt to check it against.",
	"Report cards are compiled by hand at the end of term, and it costs teachers days.",
	"The head teacher cannot answer a board question without phoning three people.",
	"When a teacher leaves, their mark book leaves with them.",
	"Attendance is on paper, so it is recorded but never actually analysed.",
];

export interface ModuleGroup {
	role: string;
	question: string;
	items: readonly string[];
}

export const MODULES: readonly ModuleGroup[] = [
	{
		role: "Head teacher",
		question: "Can I see and run the whole school?",
		items: [
			"Admissions and enrolment, with full student records and admission numbers",
			"Classes, streams and academic years",
			"Timetable",
			"Attendance, daily and per period",
			"Staff records and subject allocation",
			"Announcements to the whole school",
			"Reports that reconcile to the ledger: fee collection, outstanding balances, trial balance, student statements",
			"NECTA A-Level combinations, continuous-assessment summaries and candidate export",
		],
	},
	{
		role: "Accountant",
		question: "Can I collect fees and account for them?",
		items: [
			"Arrears tracking and automatic fee reminders by SMS — the single highest-value thing in the system",
			"Fee structures per class, per term and per boarding status",
			"Invoices, receipts and fee instalments",
			"Payments by bank, M-Pesa or cash, reconciled",
			"A debtors report you can act on, class by class",
			"An immutable ledger — corrections are reversals, and every movement is a balanced journal entry",
			"Payroll with PAYE, posting straight to the ledger",
		],
	},
	{
		role: "Teacher",
		question: "Does this save me time or cost me time?",
		items: [
			"Mark attendance from a phone, including the native iOS and Android app",
			"Enter continuous assessment and exam marks",
			"Automatic grading and report-card generation",
			"Class lists and student profiles",
			"Your own timetable",
			"Message the parents of your class",
		],
	},
	{
		role: "Parent",
		question: "Do I know what is happening with my child?",
		items: [
			"Fee balance and payment history, with receipts",
			"An SMS when your child is absent",
			"Results and report cards",
			"School announcements",
			"A parent portal on the web and on your phone",
		],
	},
];

/** Modules that exist and matter, but are not the reason a school buys. */
export const ALSO: readonly string[] = [
	"Transport and routes",
	"Hostel and boarding",
	"Library",
	"Inventory",
	"Clinic visits, with a guardian SMS",
	"Data import from your existing Excel",
];

export const STEPS: readonly { title: string; body: string }[] = [
	{
		title: "You pay, we set up",
		body: "One invoice for the year. Setup begins the day payment clears — we say so up front so it is never a surprise.",
	},
	{
		title: "A 45-minute setup call",
		body: "Academic year and terms, classes and streams, subjects, grading scale, the school calendar, and your fee structures. Getting fees right here is what makes every later number correct.",
	},
	{
		title: "We import your data",
		body: "Students first, then guardians, then any fee balances carried forward. We read your existing Excel directly and validate every row. Carried-forward balances are reconciled against your own figure and signed off by the bursar.",
	},
	{
		title: "We train each role separately",
		body: "The accountant on fees and reminders. Teachers on attendance and marks, 30 minutes, on their phones. The head teacher on reports. Parent SMS goes on last, once balances are verified.",
	},
];

/** Visible FAQ text and the FAQPage JSON-LD are generated from this list. */
export const FAQ: readonly { q: string; a: string }[] = [
	{
		q: "What happens to our data if we stop paying?",
		a: "Nothing is ever deleted. Your school moves to read-only access after a grace period — never a hard lockout, and never deletion. Parents keep access to fee and results history regardless, because punishing parents for a school's unpaid invoice is not a collection strategy. This is written into our terms.",
	},
	{
		q: "We already have everything in Excel. Do we start again?",
		a: "No. We read your existing spreadsheets directly, including files with Swahili column headings, and validate every row before saving. Anything that cannot be read is explained in plain language so you can fix it. Carried-forward fee balances are reconciled against your own total before anyone signs off.",
	},
	{
		q: "Do teachers need computers?",
		a: "No. Attendance and marks work from a phone, including a native iOS and Android app. Most teacher training takes about 30 minutes.",
	},
	{
		q: "What happens when we use up the 20,000 SMS?",
		a: "You see a used-and-remaining counter in the admin screens and a warning at 80%, so it is never a surprise. Messages are never silently dropped — the SMS that fails would be the fee reminder.",
	},
	{
		q: "Is there a cheaper plan for a smaller school?",
		a: "There is one price for every school, and it includes everything. We do not run tiers: the moment one head teacher learns another paid less, we lose both.",
	},
	{
		q: "Can we ask for features specific to our school?",
		a: "Yes — up to ten of them are included, built to how your school actually works. We track them as a visible ledger you can see, so there is no argument later about what was promised.",
	},
];
