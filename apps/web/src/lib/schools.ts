import raw from "@/data/schools.json";

/**
 * The school list, bundled as a STATIC dataset rather than a database table.
 *
 * The funnel's whole job is to catch somebody who arrived from an SMS and will
 * not come back. It must not inherit a dependency on the database being awake:
 * on the sibling product this decision paid off immediately when the database
 * was paused and the funnel kept taking leads.
 *
 * Regenerate with `node scripts/build-schools.mjs <export.csv>`.
 */

/** The full record. `phone` and `outreachCode` NEVER leave the server. */
export interface School {
	id: string;
	name: string;
	district: string;
	region: string;
	ownership: "government" | "private" | "seminary";
	/** Per-school code used in tracked SMS links. Never echoed in a search. */
	outreachCode?: string;
}

/** What an anonymous caller is allowed to see. */
export interface PublicSchool {
	id: string;
	name: string;
	district: string;
	region: string;
}

interface Dataset {
	generatedAt: string | null;
	source: string;
	schools: School[];
}

/**
 * Development-only sample rows so the funnel is testable before the real
 * register is loaded. These are illustrative placeholders, NOT a real school
 * list — they must never be served in production, where an empty dataset is
 * the honest answer.
 */
const DEV_SAMPLES: School[] = [
	{
		id: "sample-1",
		name: "Sample Secondary School",
		district: "Kinondoni",
		region: "Dar es Salaam",
		ownership: "private",
		outreachCode: "SAMP1",
	},
	{
		id: "sample-2",
		name: "Sample Girls Secondary School",
		district: "Moshi",
		region: "Kilimanjaro",
		ownership: "private",
		outreachCode: "SAMP2",
	},
	{
		id: "sample-3",
		name: "Example Seminary",
		district: "Arusha",
		region: "Arusha",
		ownership: "seminary",
		outreachCode: "SAMP3",
	},
];

const dataset = raw as unknown as Dataset;

const SCHOOLS: School[] =
	dataset.schools.length > 0
		? dataset.schools
		: process.env.NODE_ENV === "production"
			? []
			: DEV_SAMPLES;

/** True when production is serving an empty register — worth alerting on. */
export const datasetIsEmpty = SCHOOLS.length === 0;

const byCode = new Map<string, School>();
for (const s of SCHOOLS) {
	if (s.outreachCode) byCode.set(s.outreachCode.toUpperCase(), s);
}

const toPublic = (s: School): PublicSchool => ({
	id: s.id,
	name: s.name,
	district: s.district,
	region: s.region,
});

export const MIN_QUERY = 3;
export const MAX_RESULTS = 8;

/**
 * Anonymous autocomplete. Returns name, district and region only — the
 * endpoint is anonymous by definition, so anything reachable from it is
 * effectively published. Name-prefix matches rank first.
 */
export function searchSchools(query: string): PublicSchool[] {
	const q = query.trim().toLowerCase();
	if (q.length < MIN_QUERY) return [];

	const prefix: School[] = [];
	const contains: School[] = [];
	for (const s of SCHOOLS) {
		const name = s.name.toLowerCase();
		if (name.startsWith(q)) prefix.push(s);
		else if (name.includes(q) || s.district.toLowerCase().includes(q))
			contains.push(s);
		if (prefix.length >= MAX_RESULTS) break;
	}
	return [...prefix, ...contains].slice(0, MAX_RESULTS).map(toPublic);
}

/**
 * Server-side re-resolution. NEVER trust a posted school name, or a lead
 * arrives in the sales inbox claiming to be a school it is not.
 */
export function schoolById(id: string): School | undefined {
	return SCHOOLS.find((s) => s.id === id);
}

/**
 * Resolve a tracked outreach code, case-insensitively. Returns undefined for
 * an unknown code — the caller must fall through to the normal funnel rather
 * than 404, because codes get truncated by SMS clients, retyped by hand and
 * forwarded between colleagues.
 */
export function schoolByOutreachCode(code: string): School | undefined {
	return byCode.get(code.trim().toUpperCase());
}
