/**
 * THE OFFER — one price, one place.
 *
 * The landing page, the funnel and the JSON-LD structured data all render from
 * this file. Never write the price as a literal anywhere else: on the sibling
 * product these drifted apart for about an hour, and in that time the homepage's
 * structured data was still advertising retired prices to Google after the
 * visible page had changed. A prospect gets an SMS quoting one number, opens the
 * site to check you are serious, and finds another.
 *
 * When the offer changes, the JSON-LD changes in the same edit — because it is
 * generated from these constants.
 */

export const PRICE_TZS = 2_500_000; // per year
export const FREE_SMS = 20_000;
export const FREE_FEATURE_REQUESTS = 10;
export const CURRENCY = "TZS";

/** A typical school size, used for the per-student value frame. */
const EXAMPLE_STUDENTS = 500;

export const perStudentPerYear = Math.round(PRICE_TZS / EXAMPLE_STUDENTS);
export const perStudentPerMonth = Math.round(PRICE_TZS / EXAMPLE_STUDENTS / 12);

export const fmtTZS = (n: number) => `TZS ${n.toLocaleString("en-US")}`;

/** One price for everybody. No tiers — see the brief: Tanzanian school
 *  networks talk, and the moment one head teacher learns another paid less you
 *  lose both. */
export const INCLUSIONS: readonly string[] = [
	"All modules — for the head teacher, accountant, teachers and parents",
	`${FREE_SMS.toLocaleString("en-US")} SMS a year for fee reminders, attendance alerts and results`,
	"The ATLAS AI assistant",
	`Up to ${FREE_FEATURE_REQUESTS} custom features built to how your school actually works`,
	"Unlimited students, staff, classes and streams",
	"Parent portal and parent access",
	"Data import from your existing spreadsheets",
	"Training and onboarding for every role",
	"Every update released during the year",
];

export const OFFER = {
	priceTZS: PRICE_TZS,
	currency: CURRENCY,
	billingPeriod: "P1Y",
	freeSms: FREE_SMS,
	freeFeatureRequests: FREE_FEATURE_REQUESTS,
	inclusions: INCLUSIONS,
} as const;
