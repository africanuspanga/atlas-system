/**
 * The four things a school is really buying, and the bento of what is
 * included.
 *
 * Every figure here is verifiable from lib/offer.ts or from the product. There
 * are deliberately NO customer logos, testimonials or result statistics: ATLAS
 * has no schools live yet, and inventing them is a refund conversation later.
 */

export const PILLARS = [
	{
		title: "Money",
		body: "Fee structures, invoices and receipts, arrears, and an immutable ledger where every movement is a balanced journal entry.",
		href: "#roles",
	},
	{
		title: "Records",
		body: "Students, guardians, staff, classes and streams, attendance and marks — in one place, and still there when a teacher leaves.",
		href: "#roles",
	},
	{
		title: "Messages",
		body: "Fee reminders, absence alerts and results, sent to the right parent with their own child's figures in them.",
		href: "#fees",
	},
	{
		title: "Answers",
		body: "Reports that reconcile to the ledger, and an assistant you can ask in plain language without it inventing a number.",
		href: "#assistant",
	},
] as const;

export interface BentoTile {
	figure?: string;
	label: string;
	body?: string;
	wide?: boolean;
	dark?: boolean;
}

export const BENTO: readonly BentoTile[] = [
	{
		figure: "20,000",
		label: "SMS included, every year",
		body: "Roughly TZS 400,000–600,000 of messaging at market rates — a meaningful part of the fee, straight back.",
		wide: true,
	},
	{ figure: "10", label: "Custom features, built to how your school works" },
	{ figure: "1", label: "Price. No tiers, no per-student billing" },
	{
		figure: "∞",
		label: "Students, staff, classes and streams",
	},
	{
		figure: "4",
		label: "Roles, each with their own view and permissions",
	},
	{
		label: "Immutable by design",
		body: "Financial records cannot be edited. A correction is a reversal, so the audit trail is the truth.",
		wide: true,
		dark: true,
	},
	{
		label: "NECTA-ready",
		body: "A-Level combinations, continuous-assessment summaries and candidate export.",
	},
	{
		label: "On the phone",
		body: "A native iOS and Android app for attendance, marks and the parent portal.",
	},
	{
		label: "Your Excel, imported",
		body: "We read the spreadsheets you already keep — Swahili column headings included — and validate every row.",
		wide: true,
	},
];
