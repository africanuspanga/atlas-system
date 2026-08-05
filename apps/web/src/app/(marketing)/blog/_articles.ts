/**
 * Blog content and its block schema.
 *
 * The image block is part of the schema from the start rather than retrofitted:
 * every article carries a hero plus two or three in-body product screenshots
 * with captions, and a slot that has no capture yet renders a labelled
 * placeholder naming the exact screen it needs.
 *
 * ATLAS is English-only, so these are written in plain English. Terms a head
 * teacher would actually say and search for — "report card", "attendance",
 * "arrears", "timetable" — are kept as-is rather than reworded.
 */

export type Block =
	| { type: "p"; text: string }
	| { type: "h2"; text: string }
	| { type: "list"; items: readonly string[] }
	| { type: "quote"; text: string }
	| {
			type: "image";
			/** Missing src renders a labelled placeholder. */
			src?: string;
			alt: string;
			caption: string;
			/** The exact screen this slot needs captured. */
			needs?: string;
	  };

export interface Article {
	slug: string;
	title: string;
	description: string;
	/** ISO date. Absolute, never relative. */
	published: string;
	readingMinutes: number;
	hero: { src?: string; alt: string; caption: string; needs?: string };
	body: readonly Block[];
}

export const ARTICLES: readonly Article[] = [
	{
		slug: "school-system-instead-of-exercise-books",
		title: "Why a school needs a system, not another exercise book",
		description:
			"Exercise books and Excel do not fail loudly. They fail quietly, at the end of term, when the numbers have to add up.",
		published: "2026-08-05",
		readingMinutes: 6,
		hero: {
			alt: "The ATLAS dashboard showing attendance, collections and outstanding balances",
			caption: "One screen the head teacher can answer a board question from.",
			needs: "/dashboard as a head teacher, demo tenant",
		},
		body: [
			{
				type: "p",
				text: "Almost every school we speak to already has a system. It is an exercise book for fees, a spreadsheet for marks, a WhatsApp group for parents, and the bursar's memory holding it together. It works, most of the time, which is exactly why it survives.",
			},
			{
				type: "p",
				text: "The trouble is that it does not fail loudly. It fails quietly, and always at the end of term, when somebody finally has to add everything up.",
			},
			{ type: "h2", text: "Where it actually breaks" },
			{
				type: "list",
				items: [
					"Nobody knows total arrears until the term is nearly over — because arrears are a subtraction nobody has done yet.",
					"A parent says they paid. There is no receipt to check it against, so the school takes their word for it or risks the relationship.",
					"Report cards are compiled by hand, and it costs teachers days they do not have.",
					"When a teacher leaves, their mark book leaves with them.",
					"Attendance is written down every morning and analysed never.",
				],
			},
			{
				type: "p",
				text: "None of these is a discipline problem. They are all the same structural problem: the school's information lives in places that cannot be added together.",
			},
			{
				type: "image",
				alt: "The debtors report broken down class by class",
				caption:
					"Arrears stop being an end-of-term surprise when the subtraction is already done.",
				needs: "/finance/debtors as a bursar",
			},
			{ type: "h2", text: "What changes when it is one system" },
			{
				type: "p",
				text: "The point of a school system is not that it stores the same information more neatly. It is that the information becomes connected. A payment recorded against an invoice updates the student's balance, the class debtors list and the term's collection figure at the same moment, because they are the same fact viewed from different angles.",
			},
			{
				type: "p",
				text: "In ATLAS, every money movement posts a balanced journal entry, and financial records are immutable — a correction is a reversal, not an edit. That sounds like accounting pedantry until the first time a parent disputes a payment from four months ago and the answer takes ten seconds instead of an afternoon.",
			},
			{
				type: "quote",
				text: "The head teacher should be able to answer a board question without phoning three people.",
			},
			{ type: "h2", text: "The honest cost" },
			{
				type: "p",
				text: "Moving to a system costs a real setup call, a real data import and real training. The import is the part schools underestimate: carried-forward fee balances have to be reconciled against the school's own figure and signed off by the bursar before anyone trusts a single number after that.",
			},
			{
				type: "p",
				text: "That is a day of work. It replaces roughly a week per term, every term, forever.",
			},
		],
	},

	{
		slug: "collect-school-fees-on-time",
		title: "How to collect school fees on time",
		description:
			"Most schools do not have a fee-collection problem. They have an arrears-visibility problem, and the two need very different fixes.",
		published: "2026-08-05",
		readingMinutes: 7,
		hero: {
			alt: "The debtors report with outstanding balances per class",
			caption: "Every parent who owes, grouped by class, with one button to remind them.",
			needs: "/finance/debtors as a bursar",
		},
		body: [
			{
				type: "p",
				text: "Ask a bursar how much the school is owed and you will usually get a number that is roughly right, given confidently, and arrived at by memory. Ask which parents make up that number and the answer takes a week.",
			},
			{
				type: "p",
				text: "That gap is the whole problem. A school cannot chase a total. It can only chase people.",
			},
			{ type: "h2", text: "Arrears are a list, not a figure" },
			{
				type: "p",
				text: "The single highest-value thing in a school system is not the invoice. It is the debtors list: every student with a balance, grouped by class, sorted by how much and how long. Once that list exists and is correct, collection stops being a project and becomes a routine.",
			},
			{
				type: "image",
				alt: "An invoice with payments recorded against it",
				caption:
					"Bank, M-Pesa and cash all land on the same invoice, and reconcile to the same ledger.",
				needs: "/finance/[id] invoice with payments recorded",
			},
			{ type: "h2", text: "Reminders have to be automatic, or they do not happen" },
			{
				type: "p",
				text: "Every school intends to send fee reminders. Very few send them consistently, because doing it by hand means one person typing 300 messages with 300 different balances in them — and getting one wrong is worse than sending none.",
			},
			{
				type: "p",
				text: "Automatic reminders solve the arithmetic and the consistency at once. Each parent gets their own child's balance, their own invoice number and their own due date. ATLAS includes 20,000 SMS a year, which is more than most schools use for reminders, absence alerts and results combined.",
			},
			{ type: "h2", text: "Turn reminders on last" },
			{
				type: "p",
				text: "This is the part worth being stubborn about. Parent SMS should be the last thing switched on during onboarding, after fee balances have been verified and signed off.",
			},
			{
				type: "quote",
				text: "A wrong balance sent to 500 parents is the fastest way for a school to lose trust it spent years building.",
			},
			{
				type: "p",
				text: "The order matters more than the speed. Import the balances, reconcile them against the school's own total, have the bursar sign off, then turn on messaging.",
			},
			{ type: "h2", text: "What good looks like by mid-term" },
			{
				type: "list",
				items: [
					"The debtors list is current, not reconstructed.",
					"Every payment has a receipt the parent can see in the portal.",
					"Reminders went out on a schedule nobody had to remember.",
					"The collection figure on the report reconciles to the ledger, so the board question has one answer rather than three.",
				],
			},
		],
	},

	{
		slug: "ai-in-a-school-system-in-practice",
		title: "What AI in a school system actually does",
		description:
			"Not a chatbot bolted onto a dashboard. A way to ask the school a question and get an answer that reconciles to the ledger.",
		published: "2026-08-05",
		readingMinutes: 5,
		hero: {
			alt: "The ATLAS assistant answering a question about fee collection",
			caption: "Ask in plain language; the answer comes from the school's own data.",
			needs: "/assistant with a fee-collection question answered",
		},
		body: [
			{
				type: "p",
				text: "Most software that advertises AI has added a chat box that summarises what is already on the screen. That is not useless, but it is not worth changing systems for.",
			},
			{
				type: "p",
				text: "The version worth having answers questions you would otherwise have to build a report for.",
			},
			{ type: "h2", text: "Questions a head teacher actually asks" },
			{
				type: "list",
				items: [
					"How much did we collect this week?",
					"Who was absent in Form 2 today?",
					"Which parents still owe for this term?",
					"Which classes are furthest behind on fees?",
				],
			},
			{
				type: "p",
				text: "Each of those is a five-minute job with a spreadsheet and a ten-second job with an assistant that can read the school's own records.",
			},
			{ type: "h2", text: "The two rules that make it safe" },
			{
				type: "p",
				text: "First: the assistant sees exactly what you see. It reaches data through a fixed catalogue of tools, every call is permission-checked against your role, and the school is taken from the server session rather than from anything the model says. A teacher asking a finance question does not get a finance answer.",
			},
			{
				type: "p",
				text: "Second: it never computes money. Financial figures come from the same report functions the finance screens use — the ones that reconcile to the ledger and fail loudly if they do not. A language model that does its own arithmetic on fees is a liability, not a feature.",
			},
			{
				type: "image",
				alt: "The assistant proposing an action for a person to confirm",
				caption:
					"Anything that changes data is proposed, never done. A person presses confirm.",
				needs: "/assistant with a proposed action awaiting confirmation",
			},
			{ type: "h2", text: "Nothing happens without a person" },
			{
				type: "p",
				text: "Reading is one thing; changing the school's records is another. In ATLAS the assistant can only ever propose a write — recording a payment, marking attendance, linking a guardian. The proposal is shown to you with a preview, and it does not happen until you press confirm. The confirm step is not reachable by the model at all, by design.",
			},
			{
				type: "quote",
				text: "A module the assistant cannot operate is an incomplete module. A module it can change without asking is a dangerous one.",
			},
		],
	},

	{
		slug: "report-cards-from-days-to-an-afternoon",
		title: "Report cards: from days of work to one afternoon",
		description:
			"End of term does not have to mean a week of copying marks by hand. Most of the work is already done — it is just scattered.",
		published: "2026-08-05",
		readingMinutes: 5,
		hero: {
			alt: "A generated report card for a student",
			caption:
				"Generated from the marks teachers already entered during the term.",
			needs: "/students/[id]/report-card with a published term",
		},
		body: [
			{
				type: "p",
				text: "The end-of-term crush is not caused by the amount of work. It is caused by when the work happens. Marks exist all term, in mark books, in the teachers' own notebooks, on loose sheets. None of it is added up until the last two weeks, and then all of it is added up at once, by hand, by people who also still have lessons to teach.",
			},
			{ type: "h2", text: "Enter marks when they happen" },
			{
				type: "p",
				text: "If continuous assessment and exam marks go in as they are produced, the end of term stops being a data-entry exercise and becomes a review exercise. The totals, the grades and the positions are already computed; what is left is checking them and writing comments.",
			},
			{
				type: "image",
				alt: "A teacher entering marks for a class",
				caption: "Marks go in per assessment, during the term, from a phone or a laptop.",
				needs: "/assessments/[id] marks entry with a class loaded",
			},
			{ type: "h2", text: "Grading should be a rule, not a habit" },
			{
				type: "p",
				text: "Every school has a grading scale. In most schools it lives in a head of department's head and is applied slightly differently by different teachers. Written down once as a rule the system applies, it becomes consistent across every subject and every stream — and it stops being re-litigated every term.",
			},
			{
				type: "p",
				text: "For A-Level, ATLAS handles NECTA combinations, continuous-assessment summaries and candidate export, so the registration work is not a second manual exercise on top of the first.",
			},
			{ type: "h2", text: "Publishing is a decision, not an accident" },
			{
				type: "p",
				text: "Marks should be visible to teachers while they are being entered and to parents only when the school decides. Publishing an assessment locks the marks — deliberately, because a mark that changes after a parent has seen it is a conversation nobody wants.",
			},
			{
				type: "image",
				alt: "A parent viewing results in the portal",
				caption:
					"Parents see results and balances in the portal, on the web or on their phone.",
				needs: "/portal as a linked guardian",
			},
			{
				type: "p",
				text: "The week you get back is the point. Nothing here is clever; it is just moving the work to when it is small.",
			},
		],
	},
];

export const bySlug = (slug: string) => ARTICLES.find((a) => a.slug === slug);
