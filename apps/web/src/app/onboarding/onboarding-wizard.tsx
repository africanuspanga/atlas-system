"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
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
	educationLevel: EducationLevel;
	gradeName: string;
	sequence: number;
	streams: string; // comma-separated in the UI, split on submit
}

const LEVEL_PRESETS: Record<EducationLevel, { label: string; grades: string[] }> = {
	pre_primary: { label: "Pre-primary (Chekechea)", grades: ["Chekechea"] },
	primary: {
		label: "Primary (Darasa I–VII)",
		grades: ["Std I", "Std II", "Std III", "Std IV", "Std V", "Std VI", "Std VII"],
	},
	o_level: { label: "O-Level (Form 1–4)", grades: ["Form 1", "Form 2", "Form 3", "Form 4"] },
	a_level: { label: "A-Level (Form 5–6)", grades: ["Form 5", "Form 6"] },
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
	const [defaultLanguage, setDefaultLanguage] = useState<"en" | "sw">("en");
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
		// Build class rows from the selected levels, keeping any edits when
		// the user goes back and forth.
		const rows: ClassRow[] = [];
		let sequence = 0;
		for (const level of ["pre_primary", "primary", "o_level", "a_level"] as const) {
			if (!levels.includes(level)) continue;
			for (const grade of LEVEL_PRESETS[level].grades) {
				sequence += 1;
				const existing = classes.find((c) => c.gradeName === grade);
				rows.push(
					existing ?? { educationLevel: level, gradeName: grade, sequence, streams: "A" },
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
				setError("Your session expired. Please sign in again.");
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
					defaultLanguage,
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

			const response = await fetch(
				`${process.env.NEXT_PUBLIC_API_URL}/api/v1/onboarding`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${session.access_token}`,
					},
					body: JSON.stringify(payload),
				},
			);

			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(
					body?.message ?? body?.code ?? `Setup failed (HTTP ${response.status}). Try again.`,
				);
				return;
			}

			router.push("/");
			router.refresh();
		} catch {
			setError("Could not reach the ATLAS API. Is it running?");
		} finally {
			setPending(false);
		}
	}

	return (
		<Card className="shadow-none">
			<CardHeader>
				<div className="flex items-center gap-2">
					<CardTitle>Set up your school</CardTitle>
					<Badge variant="outline">Step {step} of 3</Badge>
				</div>
				<CardDescription>
					{step === 1 && "Tell us about your school."}
					{step === 2 && "Configure your academic year and terms."}
					{step === 3 && "Review your classes and streams — edit anything you need."}
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{step === 1 && (
					<>
						<Field label="School name">
							<Input
								value={name}
								onChange={(e) => {
									setName(e.target.value);
									setSlug(slugify(e.target.value));
								}}
								placeholder="Mwenge Secondary School"
							/>
						</Field>
						<Field label="ATLAS address (auto-generated, editable)">
							<Input
								value={slug}
								onChange={(e) => setSlug(slugify(e.target.value))}
								placeholder="mwenge-secondary"
							/>
						</Field>
						<div className="grid grid-cols-2 gap-4">
							<Field label="Region">
								<Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Dar es Salaam" />
							</Field>
							<Field label="District">
								<Input value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="Kinondoni" />
							</Field>
						</div>
						<Field label="Phone">
							<Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+255 7XX XXX XXX" />
						</Field>
						<Field label="Default language">
							<div className="flex gap-2">
								<Button
									onClick={() => setDefaultLanguage("en")}
									size="sm"
									type="button"
									variant={defaultLanguage === "en" ? "default" : "outline"}
								>
									English
								</Button>
								<Button
									onClick={() => setDefaultLanguage("sw")}
									size="sm"
									type="button"
									variant={defaultLanguage === "sw" ? "default" : "outline"}
								>
									Kiswahili
								</Button>
							</div>
						</Field>
						<Field label="Education levels offered">
							<div className="flex flex-wrap gap-2">
								{(Object.keys(LEVEL_PRESETS) as EducationLevel[]).map((level) => (
									<Button
										key={level}
										onClick={() => toggleLevel(level)}
										size="sm"
										type="button"
										variant={levels.includes(level) ? "default" : "outline"}
									>
										{LEVEL_PRESETS[level].label}
									</Button>
								))}
							</div>
						</Field>
						<Button
							className="mt-2 self-end"
							disabled={name.length < 2 || slug.length < 3 || levels.length === 0}
							onClick={() => setStep(2)}
						>
							Continue
						</Button>
					</>
				)}

				{step === 2 && (
					<>
						<div className="grid grid-cols-3 gap-4">
							<Field label="Year name">
								<Input value={yearName} onChange={(e) => setYearName(e.target.value)} />
							</Field>
							<Field label="Starts">
								<Input type="date" value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
							</Field>
							<Field label="Ends">
								<Input type="date" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} />
							</Field>
						</div>
						{terms.map((term, index) => (
							<div className="grid grid-cols-3 gap-4" key={index}>
								<Field label={`Term ${index + 1} name`}>
									<Input
										value={term.name}
										onChange={(e) =>
											setTerms(terms.map((t, i) => (i === index ? { ...t, name: e.target.value } : t)))
										}
									/>
								</Field>
								<Field label="Starts">
									<Input
										type="date"
										value={term.startsOn}
										onChange={(e) =>
											setTerms(terms.map((t, i) => (i === index ? { ...t, startsOn: e.target.value } : t)))
										}
									/>
								</Field>
								<Field label="Ends">
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
								Back
							</Button>
							<Button onClick={goToClasses}>Continue</Button>
						</div>
					</>
				)}

				{step === 3 && (
					<>
						<p className="text-sm text-muted-foreground">
							Streams are comma-separated — e.g. <span className="font-mono">A, B</span> creates
							two streams per class.
						</p>
						{classes.map((row, index) => (
							<div className="grid grid-cols-2 gap-4" key={row.gradeName}>
								<Field label="Class">
									<Input
										value={row.gradeName}
										onChange={(e) =>
											setClasses(
												classes.map((c, i) => (i === index ? { ...c, gradeName: e.target.value } : c)),
											)
										}
									/>
								</Field>
								<Field label="Streams">
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
								Back
							</Button>
							<Button disabled={pending} onClick={submit}>
								{pending ? "Creating your school…" : "Create school"}
							</Button>
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}
