"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { getDict } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type EducationLevel = "pre_primary" | "primary" | "o_level" | "a_level";

interface ClassRow {
	presetKey: string; // immutable preset grade name — row identity, not sent on submit
	educationLevel: EducationLevel;
	gradeName: string;
	sequence: number;
	streams: string; // comma-separated in the UI, split on submit
}

// `hint` is the grade range shown after the translated level name; grade
// names themselves are school data (identical in EN and SW).
const LEVEL_PRESETS: Record<EducationLevel, { hint: string; grades: string[] }> = {
	pre_primary: { hint: "(Chekechea)", grades: ["Chekechea"] },
	primary: {
		hint: "(Darasa I–VII)",
		grades: ["Std I", "Std II", "Std III", "Std IV", "Std V", "Std VI", "Std VII"],
	},
	o_level: { hint: "(Form 1–4)", grades: ["Form 1", "Form 2", "Form 3", "Form 4"] },
	a_level: { hint: "(Form 5–6)", grades: ["Form 5", "Form 6"] },
};

function slugify(value: string) {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/(^-|-$)+/g, "")
		.slice(0, 63);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-sm font-medium">{label}</span>
			{children}
		</div>
	);
}

export function OnboardingWizard({ email }: { email: string }) {
	const t = getDict();
	const router = useRouter();
	const [step, setStep] = useState(1);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Step 1 — school
	const [name, setName] = useState("");
	const [slug, setSlug] = useState("");
	const [region, setRegion] = useState("");
	const [district, setDistrict] = useState("");
	const [phone, setPhone] = useState("");
	const [levels, setLevels] = useState<EducationLevel[]>([]);

	// Step 2 — academic year (Tanzanian default: January–December, two terms)
	const [yearName, setYearName] = useState("2027");
	const [yearStart, setYearStart] = useState("2027-01-05");
	const [yearEnd, setYearEnd] = useState("2027-12-04");
	const [terms, setTerms] = useState([
		{ name: "Muhula wa Kwanza (Term 1)", startsOn: "2027-01-05", endsOn: "2027-06-12" },
		{ name: "Muhula wa Pili (Term 2)", startsOn: "2027-07-06", endsOn: "2027-12-04" },
	]);

	// Step 3 — classes
	const [classes, setClasses] = useState<ClassRow[]>([]);

	function toggleLevel(level: EducationLevel) {
		setLevels((prev) =>
			prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level],
		);
	}

	function goToClasses() {
		// Build class rows from the selected levels, keeping any edits (renamed
		// grade, edited streams) when the user goes back and forth. Row identity
		// is the immutable preset name — never the editable gradeName — and the
		// sequence + level are always recomputed fresh so changing the selected
		// levels can't leave stale/duplicate ordering behind.
		const rows: ClassRow[] = [];
		let sequence = 0;
		for (const level of ["pre_primary", "primary", "o_level", "a_level"] as const) {
			if (!levels.includes(level)) continue;
			for (const grade of LEVEL_PRESETS[level].grades) {
				sequence += 1;
				const existing = classes.find((c) => c.presetKey === grade);
				rows.push(
					existing
						? { ...existing, educationLevel: level, sequence }
						: {
								presetKey: grade,
								educationLevel: level,
								gradeName: grade,
								sequence,
								streams: "A",
							},
				);
			}
		}
		setClasses(rows);
		setStep(3);
	}

	async function submit() {
		setError(null);
		setPending(true);
		try {
			const supabase = createClient();
			const {
				data: { session },
			} = await supabase.auth.getSession();
			if (!session) {
				setError(t("onboard.sessionExpired"));
				return;
			}

			const payload = {
				school: {
					name,
					slug,
					email,
					phone: phone || undefined,
					region: region || undefined,
					district: district || undefined,
					defaultLanguage: "en",
				},
				academicYear: { name: yearName, startsOn: yearStart, endsOn: yearEnd, terms },
				classes: classes.map((c) => ({
					educationLevel: c.educationLevel,
					gradeName: c.gradeName,
					sequence: c.sequence,
					streams: c.streams
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean),
				})),
			};

			// apiFetch attaches auth itself and works pre-tenant (no x-tenant-id).
			const response = await apiFetch("/api/v1/onboarding", {
				method: "POST",
				body: JSON.stringify(payload),
			});

			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}

			router.push("/dashboard");
			router.refresh();
		} catch {
			setError(t("onboard.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Card className="shadow-none">
			<CardHeader>
				<div className="flex items-center gap-2">
					<CardTitle>{t("onboard.title")}</CardTitle>
					<Badge variant="outline">
						{t("onboard.step")} {step} {t("report.of")} 3
					</Badge>
				</div>
				<CardDescription>
					{step === 1 && t("onboard.desc1")}
					{step === 2 && t("onboard.desc2")}
					{step === 3 && t("onboard.desc3")}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{step === 1 && (
					<>
						<Field label={t("onboard.schoolName")}>
							<Input
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									setSlug(slugify(e.target.value));
								}}
								placeholder="Mwenge Secondary School"
							/>
						</Field>
						<Field label={t("onboard.slug")}>
							<Input
								value={slug}
								onChange={(e) => setSlug(slugify(e.target.value))}
								placeholder="mwenge-secondary"
							/>
						</Field>
						<div className="grid grid-cols-2 gap-4">
							<Field label={t("settings.region")}>
								<Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Dar es Salaam" />
							</Field>
							<Field label={t("settings.district")}>
								<Input value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="Kinondoni" />
							</Field>
						</div>
						<Field label={t("parents.phone")}>
							<Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+255 7XX XXX XXX" />
						</Field>
						<Field label={t("onboard.levels")}>
							<div className="flex flex-wrap gap-2">
								{(Object.keys(LEVEL_PRESETS) as EducationLevel[]).map((level) => (
									<Button
										key={level}
										onClick={() => toggleLevel(level)}
										size="sm"
										type="button"
										variant={levels.includes(level) ? "default" : "outline"}
									>
										{t(`academics.level.${level}`)} {LEVEL_PRESETS[level].hint}
									</Button>
								))}
							</div>
						</Field>
						<Button
							className="mt-2 self-end"
							disabled={name.length < 2 || slug.length < 3 || levels.length === 0}
							onClick={() => setStep(2)}
						>
							{t("common.continue")}
						</Button>
					</>
				)}

				{step === 2 && (
					<>
						<div className="grid grid-cols-3 gap-4">
							<Field label={t("onboard.yearName")}>
								<Input value={yearName} onChange={(e) => setYearName(e.target.value)} />
							</Field>
							<Field label={t("onboard.starts")}>
								<Input type="date" value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
							</Field>
							<Field label={t("onboard.ends")}>
								<Input type="date" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} />
							</Field>
						</div>
						{terms.map((term, index) => (
							<div className="grid grid-cols-3 gap-4" key={index}>
								<Field label={`${t("assessments.term")} ${index + 1}`}>
									<Input
										value={term.name}
										onChange={(e) =>
											setTerms(terms.map((t, i) => (i === index ? { ...t, name: e.target.value } : t)))
										}
									/>
								</Field>
								<Field label={t("onboard.starts")}>
									<Input
										type="date"
										value={term.startsOn}
										onChange={(e) =>
											setTerms(terms.map((t, i) => (i === index ? { ...t, startsOn: e.target.value } : t)))
										}
									/>
								</Field>
								<Field label={t("onboard.ends")}>
									<Input
										type="date"
										value={term.endsOn}
										onChange={(e) =>
											setTerms(terms.map((t, i) => (i === index ? { ...t, endsOn: e.target.value } : t)))
										}
									/>
								</Field>
							</div>
						))}
						<div className="flex gap-2 self-end">
							<Button onClick={() => setStep(1)} variant="outline">
								{t("common.back")}
							</Button>
							<Button onClick={goToClasses}>{t("common.continue")}</Button>
						</div>
					</>
				)}

				{step === 3 && (
					<>
						<p className="text-sm text-muted-foreground">
							{t("onboard.streamsHintBefore")}
							<span className="font-mono">A, B</span>
							{t("onboard.streamsHintAfter")}
						</p>
						{classes.map((row, index) => (
							<div className="grid grid-cols-2 gap-4" key={row.presetKey}>
								<Field label={t("students.class")}>
									<Input
										value={row.gradeName}
										onChange={(e) =>
											setClasses(
												classes.map((c, i) => (i === index ? { ...c, gradeName: e.target.value } : c)),
											)
										}
									/>
								</Field>
								<Field label={t("onboard.streams")}>
									<Input
										value={row.streams}
										onChange={(e) =>
											setClasses(
												classes.map((c, i) => (i === index ? { ...c, streams: e.target.value } : c)),
											)
										}
									/>
								</Field>
							</div>
						))}
						{error && <p className="text-sm text-destructive">{error}</p>}
						<div className="flex gap-2 self-end">
							<Button disabled={pending} onClick={() => setStep(2)} variant="outline">
								{t("common.back")}
							</Button>
							<Button disabled={pending} onClick={submit}>
								{pending ? t("onboard.creating") : t("onboard.create")}
							</Button>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
