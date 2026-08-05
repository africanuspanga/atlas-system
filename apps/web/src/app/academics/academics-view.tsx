"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DownloadIcon, LayersIcon, PlusIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { getDict, type DictKey, type Translator } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export interface SubjectRow {
	id: string;
	code: string;
	name: string;
	name_sw: string | null;
	education_level: string;
	status: string;
}

export interface GradeLevelRow {
	id: string;
	name: string;
	education_level: string;
	sequence: number;
}

export interface SectionRow {
	id: string;
	name: string;
	capacity: number | null;
	status: string;
	academic_year_id: string;
	grade_levels: { name: string; sequence: number; education_level: string } | null;
	academic_years: { name: string; starts_on: string } | null;
	class_enrolments: Array<{ count: number }>;
}

export interface YearRow {
	id: string;
	name: string;
	starts_on: string;
	ends_on: string;
	status: string;
	academic_terms: Array<{
		id: string;
		name: string;
		sequence: number;
		starts_on: string;
		ends_on: string;
	}>;
}

interface CombinationDto {
	id: string;
	code: string;
	name: string;
	subjects: Array<{ id: string; code: string; name: string; isPrincipal: boolean }>;
}

interface RosterDto {
	sectionId: string;
	academicYearId: string;
	educationLevel: string | null;
	students: Array<{
		id: string;
		studentNumber: string;
		name: string;
		combinationId: string | null;
	}>;
}

interface CaSummaryDto {
	section: string;
	educationLevel: string;
	year: { id: string; name: string };
	rows: Array<{
		studentId: string;
		studentNumber: string;
		name: string;
		subjects: Array<{ code: string; marks: number; grade: string; points: number }>;
		average: number | null;
		rank: number | null;
	}>;
	students: number;
}

const LEVEL_KEYS: Record<string, DictKey> = {
	pre_primary: "academics.level.pre_primary",
	primary: "academics.level.primary",
	o_level: "academics.level.o_level",
	a_level: "academics.level.a_level",
};

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface SectionOption {
	id: string;
	label: string;
	educationLevel: string;
}

export function AcademicsView({
	subjects,
	gradeLevels,
	sections,
	years,
	tenantId,
	canManage,
	canManageCombinations,
	canExport,
}: {
	subjects: SubjectRow[];
	gradeLevels: GradeLevelRow[];
	sections: SectionRow[];
	years: YearRow[];
	tenantId: string;
	/** academics.manage — year rollover, grade levels, streams. */
	canManage: boolean;
	canManageCombinations: boolean;
	canExport: boolean;
}) {
	const t = getDict();
	const router = useRouter();
	const reload = useCallback(() => router.refresh(), [router]);
	const levelLabel = (level: string) => {
		const key = LEVEL_KEYS[level];
		return key ? t(key) : level;
	};

	// Newest year first — after a rollover the grid holds two years of streams.
	const sortedSections = [...sections].sort(
		(a, b) =>
			(b.academic_years?.starts_on ?? "").localeCompare(a.academic_years?.starts_on ?? "") ||
			(a.grade_levels?.sequence ?? 99) - (b.grade_levels?.sequence ?? 99) ||
			a.name.localeCompare(b.name),
	);
	const sortedGradeLevels = [...gradeLevels].sort((a, b) => a.sequence - b.sequence);
	const sectionOptions: SectionOption[] = sortedSections
		.filter((s) => s.status === "active")
		.map((s) => ({
			id: s.id,
			label: `${s.grade_levels?.name ?? "?"} ${s.name}`,
			educationLevel: s.grade_levels?.education_level ?? "",
		}));

	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">{t("academics.title")}</h1>

			<Card className="shadow-none">
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<CardTitle className="text-base">{t("academics.years")}</CardTitle>
						{canManage && (
							<NewYearDialog onDone={reload} t={t} tenantId={tenantId} years={years} />
						)}
					</div>
				</CardHeader>
				<CardContent>
					{years.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("academics.yearsEmpty")}
						</p>
					) : (
						<div className="flex flex-col gap-4">
							{years.map((y) => (
								<div className="flex flex-col gap-2" key={y.id}>
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-sm font-medium">{y.name}</span>
										<span className="font-mono text-xs text-muted-foreground">
											{y.starts_on} – {y.ends_on}
										</span>
										<Badge variant="outline">{y.status}</Badge>
									</div>
									{y.academic_terms.length > 0 && (
										<Table>
											<TableHeader>
												<TableRow>
													<TableHead>{t("academics.terms")}</TableHead>
													<TableHead>{t("academics.sequence")}</TableHead>
													<TableHead>{t("attendance.date")}</TableHead>
												</TableRow>
											</TableHeader>
											<TableBody>
												{[...y.academic_terms]
													.sort((a, b) => a.sequence - b.sequence)
													.map((term) => (
														<TableRow key={term.id}>
															<TableCell>{term.name}</TableCell>
															<TableCell className="font-mono text-xs">
																{term.sequence}
															</TableCell>
															<TableCell className="font-mono text-xs text-muted-foreground">
																{term.starts_on} – {term.ends_on}
															</TableCell>
														</TableRow>
													))}
											</TableBody>
										</Table>
									)}
								</div>
							))}
						</div>
					)}
				</CardContent>
			</Card>

			<Card className="shadow-none">
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<CardTitle className="text-base">{t("academics.sections")}</CardTitle>
						{canManage && (
							<AddSectionDialog
								gradeLevels={sortedGradeLevels}
								onDone={reload}
								t={t}
								tenantId={tenantId}
								years={years}
							/>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{sortedSections.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("academics.sectionsEmpty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("academics.year")}</TableHead>
									<TableHead>{t("students.class")}</TableHead>
									<TableHead>{t("academics.stream")}</TableHead>
									<TableHead>{t("academics.enrolled")}</TableHead>
									<TableHead>{t("academics.capacity")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sortedSections.map((s) => (
									<TableRow key={s.id}>
										<TableCell className="text-muted-foreground">
											{s.academic_years?.name ?? "—"}
										</TableCell>
										<TableCell>{s.grade_levels?.name ?? "—"}</TableCell>
										<TableCell>{s.name}</TableCell>
										<TableCell className="font-mono">
											{s.class_enrolments[0]?.count ?? 0}
										</TableCell>
										<TableCell className="font-mono">{s.capacity ?? "—"}</TableCell>
										<TableCell>
											<Badge variant="outline">{s.status}</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<Card className="shadow-none">
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<CardTitle className="text-base">{t("academics.gradeLevels")}</CardTitle>
						{canManage && (
							<AddGradeLevelDialog
								gradeLevels={sortedGradeLevels}
								onDone={reload}
								t={t}
								tenantId={tenantId}
							/>
						)}
					</div>
				</CardHeader>
				<CardContent>
					{sortedGradeLevels.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("academics.gradeLevelsEmpty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("students.name")}</TableHead>
									<TableHead>{t("academics.level")}</TableHead>
									<TableHead>{t("academics.sequence")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sortedGradeLevels.map((g) => (
									<TableRow key={g.id}>
										<TableCell>{g.name}</TableCell>
										<TableCell>{levelLabel(g.education_level)}</TableCell>
										<TableCell className="font-mono">{g.sequence}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<Card className="shadow-none">
				<CardHeader>
					<CardTitle className="text-base">{t("academics.subjects")}</CardTitle>
				</CardHeader>
				<CardContent>
					{subjects.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("academics.subjectsEmpty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("academics.code")}</TableHead>
									<TableHead>{t("students.name")}</TableHead>
									<TableHead>{t("academics.level")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{subjects.map((s) => (
									<TableRow key={s.id}>
										<TableCell className="font-mono text-xs">{s.code}</TableCell>
										<TableCell>{s.name}</TableCell>
										<TableCell>{levelLabel(s.education_level)}</TableCell>
										<TableCell>
											<Badge variant="outline">{s.status}</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<CombinationsCard
				canManage={canManageCombinations}
				sections={sectionOptions}
				t={t}
				tenantId={tenantId}
			/>
			<CaSummaryCard sections={sectionOptions} t={t} tenantId={tenantId} years={years} />
			{canExport && (
				<CandidatesExportCard sections={sectionOptions} t={t} tenantId={tenantId} />
			)}
		</div>
	);
}

const EDUCATION_LEVELS = ["pre_primary", "primary", "o_level", "a_level"] as const;

interface TermDraft {
	name: string;
	startsOn: string;
	endsOn: string;
}

/**
 * Terms are data, not UI copy — they are stored verbatim and printed on report
 * cards, so the defaults mirror the bilingual names the onboarding wizard
 * writes rather than being translated per viewer.
 */
function defaultTerms(): TermDraft[] {
	return [
		{ name: "Muhula wa Kwanza (Term 1)", startsOn: "", endsOn: "" },
		{ name: "Muhula wa Pili (Term 2)", startsOn: "", endsOn: "" },
		{ name: "Muhula wa Tatu (Term 3)", startsOn: "", endsOn: "" },
	];
}

/**
 * Academic-year rollover — migration 0030. academic_years, academic_terms and
 * class_sections used to be written only inside app.onboard_school, which runs
 * once, so a school onboarded in 2026 had no path into 2027 at all. Creating
 * the year and activating it are two deliberate steps: activation moves every
 * register, assessment and class list onto the new year.
 */
function NewYearDialog({
	tenantId,
	years,
	t,
	onDone,
}: {
	tenantId: string;
	years: YearRow[];
	t: Translator;
	onDone: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [startsOn, setStartsOn] = useState("");
	const [endsOn, setEndsOn] = useState("");
	const [cloneFrom, setCloneFrom] = useState("");
	const [terms, setTerms] = useState<TermDraft[]>(defaultTerms);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<{
		academicYearId: string;
		terms: number;
		sectionsCloned: number;
	} | null>(null);
	const [activated, setActivated] = useState(false);

	// Reset on open AND close — a reopened dialog must never inherit the last
	// draft, nor the "created / activate now" panel from a previous run.
	function handleOpenChange(next: boolean) {
		setName("");
		setStartsOn("");
		setEndsOn("");
		setCloneFrom("");
		setTerms(defaultTerms());
		setPending(false);
		setError(null);
		setCreated(null);
		setActivated(false);
		setOpen(next);
	}

	function setTerm(index: number, field: keyof TermDraft, value: string) {
		setTerms((prev) =>
			prev.map((term, i) => (i === index ? { ...term, [field]: value } : term)),
		);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (pending) return;
		// Cheap client guard so an obvious date slip does not cost a round trip;
		// the API re-validates the same rules with zod either way.
		if (
			endsOn <= startsOn ||
			terms.some((term) => !term.name.trim() || term.endsOn <= term.startsOn)
		) {
			setError(t("err.invalid"));
			return;
		}
		setPending(true);
		setError(null);
		let payload: { academicYearId: string; terms: number; sectionsCloned: number } | null =
			null;
		try {
			const response = await apiFetch("/api/v1/academics/years", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					name: name.trim(),
					startsOn,
					endsOn,
					cloneSectionsFromYearId: cloneFrom || undefined,
					terms: terms.map((term) => ({
						name: term.name.trim(),
						startsOn: term.startsOn,
						endsOn: term.endsOn,
					})),
				}),
			});
			const body = (await response.json().catch(() => null)) as {
				code?: string;
				academicYearId?: string;
				terms?: number;
				sectionsCloned?: number;
			} | null;
			if (!response.ok || !body?.academicYearId) {
				setError(apiErrorMessage(t, body, response.status));
			} else {
				payload = {
					academicYearId: body.academicYearId,
					terms: body.terms ?? 0,
					sectionsCloned: body.sectionsCloned ?? 0,
				};
			}
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
		if (payload) {
			setCreated(payload);
			onDone();
		}
	}

	async function activate() {
		if (pending || !created) return;
		setPending(true);
		setError(null);
		let ok = false;
		try {
			const response = await apiFetch(
				`/api/v1/academics/years/${created.academicYearId}/activate`,
				{ method: "POST", tenantId, body: JSON.stringify({}) },
			);
			if (response.ok) {
				ok = true;
			} else {
				const body = (await response.json().catch(() => null)) as { code?: string } | null;
				setError(apiErrorMessage(t, body, response.status));
			}
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
		if (ok) {
			setActivated(true);
			onDone();
		}
	}

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={<Button size="sm" />}>
				<PlusIcon /> {t("academics.newYear")}
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("academics.newYear")}</DialogTitle>
				</DialogHeader>
				{created ? (
					<div className="flex flex-col gap-3">
						<p className="text-sm font-medium text-primary">{t("academics.yearCreated")}</p>
						<p className="text-sm text-muted-foreground">
							<span className="font-mono">{created.terms}</span> {t("academics.termsCreated")}{" "}
							· <span className="font-mono">{created.sectionsCloned}</span>{" "}
							{t("academics.sectionsCloned")}
						</p>
						<p className="text-xs text-muted-foreground">{t("academics.activateHint")}</p>
						{activated && (
							<p className="text-sm font-medium text-primary">
								{t("academics.yearActivated")}
							</p>
						)}
						{error && <p className="text-sm text-destructive">{error}</p>}
						<div className="flex justify-end gap-2">
							<Button
								disabled={pending}
								onClick={() => handleOpenChange(false)}
								type="button"
								variant="outline"
							>
								{t("common.close")}
							</Button>
							{!activated && (
								<Button disabled={pending} onClick={() => void activate()} type="button">
									{pending ? t("common.loading") : t("academics.activateNow")}
								</Button>
							)}
						</div>
					</div>
				) : (
					<form className="flex flex-col gap-3" onSubmit={submit}>
						<p className="text-xs text-muted-foreground">{t("academics.newYearHint")}</p>
						<Input
							maxLength={50}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("academics.yearName")}
							required
							value={name}
						/>
						<div className="grid grid-cols-2 gap-3">
							<label className="flex flex-col gap-1 text-xs text-muted-foreground">
								{t("academics.startsOn")}
								<Input
									onChange={(e) => setStartsOn(e.target.value)}
									required
									type="date"
									value={startsOn}
								/>
							</label>
							<label className="flex flex-col gap-1 text-xs text-muted-foreground">
								{t("academics.endsOn")}
								<Input
									onChange={(e) => setEndsOn(e.target.value)}
									required
									type="date"
									value={endsOn}
								/>
							</label>
						</div>

						<div className="flex items-center justify-between gap-2">
							<h3 className="text-sm font-semibold">{t("academics.terms")}</h3>
							<Button
								disabled={pending || terms.length >= 6}
								onClick={() =>
									setTerms((prev) => [...prev, { name: "", startsOn: "", endsOn: "" }])
								}
								size="sm"
								type="button"
								variant="outline"
							>
								{t("academics.addTerm")}
							</Button>
						</div>
						{terms.map((term, index) => (
							<div
								className="flex flex-col gap-2 rounded-xl border p-3"
								key={`term-${index}`}
							>
								<Input
									maxLength={50}
									onChange={(e) => setTerm(index, "name", e.target.value)}
									placeholder={t("academics.termName")}
									required
									value={term.name}
								/>
								<div className="grid grid-cols-2 gap-2">
									<Input
										onChange={(e) => setTerm(index, "startsOn", e.target.value)}
										required
										type="date"
										value={term.startsOn}
									/>
									<Input
										onChange={(e) => setTerm(index, "endsOn", e.target.value)}
										required
										type="date"
										value={term.endsOn}
									/>
								</div>
								{terms.length > 1 && (
									<Button
										className="self-end"
										disabled={pending}
										onClick={() => setTerms((prev) => prev.filter((_, i) => i !== index))}
										size="sm"
										type="button"
										variant="outline"
									>
										{t("academics.removeTerm")}
									</Button>
								)}
							</div>
						))}
						<p className="text-xs text-muted-foreground">{t("academics.termsHint")}</p>

						<label className="flex flex-col gap-1 text-xs text-muted-foreground">
							{t("academics.cloneFrom")}
							<select
								className={selectClass}
								onChange={(e) => setCloneFrom(e.target.value)}
								value={cloneFrom}
							>
								<option value="">{t("academics.cloneNone")}</option>
								{years.map((y) => (
									<option key={y.id} value={y.id}>
										{y.name}
									</option>
								))}
							</select>
						</label>
						<p className="text-xs text-muted-foreground">{t("academics.cloneHint")}</p>

						{error && <p className="text-sm text-destructive">{error}</p>}
						<div className="flex justify-end gap-2">
							<Button
								disabled={pending}
								onClick={() => handleOpenChange(false)}
								type="button"
								variant="outline"
							>
								{t("common.cancel")}
							</Button>
							<Button disabled={pending} type="submit">
								{pending ? t("common.loading") : t("common.save")}
							</Button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** Grade levels are tenant-wide and reused by every year's section grid. */
function AddGradeLevelDialog({
	tenantId,
	gradeLevels,
	t,
	onDone,
}: {
	tenantId: string;
	gradeLevels: GradeLevelRow[];
	t: Translator;
	onDone: () => void;
}) {
	const nextSequence = String(
		Math.min(100, gradeLevels.reduce((max, g) => Math.max(max, g.sequence), 0) + 1),
	);
	const [open, setOpen] = useState(false);
	const [educationLevel, setEducationLevel] = useState<string>("o_level");
	const [name, setName] = useState("");
	const [sequence, setSequence] = useState(nextSequence);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function handleOpenChange(next: boolean) {
		setEducationLevel("o_level");
		setName("");
		setSequence(nextSequence);
		setPending(false);
		setError(null);
		setOpen(next);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (pending) return;
		setPending(true);
		setError(null);
		let ok = false;
		try {
			const response = await apiFetch("/api/v1/academics/grade-levels", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					educationLevel,
					name: name.trim(),
					sequence: Number(sequence),
				}),
			});
			if (response.ok) {
				ok = true;
			} else {
				const body = (await response.json().catch(() => null)) as { code?: string } | null;
				setError(apiErrorMessage(t, body, response.status));
			}
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
		if (ok) {
			setOpen(false);
			onDone();
		}
	}

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				<PlusIcon /> {t("academics.addGradeLevel")}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("academics.addGradeLevel")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						{t("academics.level")}
						<select
							className={selectClass}
							onChange={(e) => setEducationLevel(e.target.value)}
							value={educationLevel}
						>
							{EDUCATION_LEVELS.map((level) => (
								<option key={level} value={level}>
									{t(LEVEL_KEYS[level])}
								</option>
							))}
						</select>
					</label>
					<Input
						maxLength={50}
						onChange={(e) => setName(e.target.value)}
						placeholder={t("academics.gradeName")}
						required
						value={name}
					/>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						{t("academics.gradeSequence")}
						<Input
							max={100}
							min={1}
							onChange={(e) => setSequence(e.target.value)}
							required
							type="number"
							value={sequence}
						/>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button
							disabled={pending}
							onClick={() => handleOpenChange(false)}
							type="button"
							variant="outline"
						>
							{t("common.cancel")}
						</Button>
						<Button disabled={pending} type="submit">
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A stream is a class_sections row — its `name` IS the stream label ("A"). */
function AddSectionDialog({
	tenantId,
	years,
	gradeLevels,
	t,
	onDone,
}: {
	tenantId: string;
	years: YearRow[];
	gradeLevels: GradeLevelRow[];
	t: Translator;
	onDone: () => void;
}) {
	const defaultYear = (years.find((y) => y.status === "active") ?? years[0])?.id ?? "";
	const [open, setOpen] = useState(false);
	const [academicYearId, setAcademicYearId] = useState(defaultYear);
	const [gradeLevelId, setGradeLevelId] = useState("");
	const [name, setName] = useState("");
	const [capacity, setCapacity] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function handleOpenChange(next: boolean) {
		setAcademicYearId(defaultYear);
		setGradeLevelId("");
		setName("");
		setCapacity("");
		setPending(false);
		setError(null);
		setOpen(next);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (pending || !academicYearId || !gradeLevelId) return;
		setPending(true);
		setError(null);
		let ok = false;
		try {
			const response = await apiFetch("/api/v1/academics/sections", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					academicYearId,
					gradeLevelId,
					name: name.trim(),
					capacity: capacity ? Number(capacity) : undefined,
				}),
			});
			if (response.ok) {
				ok = true;
			} else {
				const body = (await response.json().catch(() => null)) as { code?: string } | null;
				setError(apiErrorMessage(t, body, response.status));
			}
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
		if (ok) {
			setOpen(false);
			onDone();
		}
	}

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				<PlusIcon /> {t("academics.addSection")}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("academics.addSection")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					{years.length === 0 && (
						<p className="text-sm text-muted-foreground">{t("academics.noYears")}</p>
					)}
					{gradeLevels.length === 0 && (
						<p className="text-sm text-muted-foreground">{t("academics.noGrades")}</p>
					)}
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						{t("academics.year")}
						<select
							className={selectClass}
							onChange={(e) => setAcademicYearId(e.target.value)}
							value={academicYearId}
						>
							<option value="">{t("academics.pickYear")}</option>
							{years.map((y) => (
								<option key={y.id} value={y.id}>
									{y.name}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">
						{t("students.class")}
						<select
							className={selectClass}
							onChange={(e) => setGradeLevelId(e.target.value)}
							value={gradeLevelId}
						>
							<option value="">{t("academics.pickGrade")}</option>
							{gradeLevels.map((g) => (
								<option key={g.id} value={g.id}>
									{g.name}
								</option>
							))}
						</select>
					</label>
					<Input
						maxLength={20}
						onChange={(e) => setName(e.target.value)}
						placeholder={t("academics.sectionName")}
						required
						value={name}
					/>
					<Input
						max={500}
						min={1}
						onChange={(e) => setCapacity(e.target.value)}
						placeholder={t("academics.sectionCapacity")}
						type="number"
						value={capacity}
					/>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button
							disabled={pending}
							onClick={() => handleOpenChange(false)}
							type="button"
							variant="outline"
						>
							{t("common.cancel")}
						</Button>
						<Button disabled={pending || !academicYearId || !gradeLevelId} type="submit">
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** A-Level subject combinations: catalogue + per-student assignment roster. */
function CombinationsCard({
	tenantId,
	sections,
	canManage,
	t,
}: {
	tenantId: string;
	sections: SectionOption[];
	canManage: boolean;
	t: Translator;
}) {
	const [combinations, setCombinations] = useState<CombinationDto[]>([]);
	const [presetResult, setPresetResult] = useState<{ created: number; skipped: number } | null>(
		null,
	);
	const [sectionId, setSectionId] = useState("");
	const [roster, setRoster] = useState<RosterDto | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const aLevelSections = sections.filter((s) => s.educationLevel === "a_level");

	const reloadCombinations = useCallback(async () => {
		const response = await apiFetch("/api/v1/academics/combinations", { tenantId });
		if (response.ok) {
			setCombinations(((await response.json()) as { data: CombinationDto[] }).data);
		} else {
			const body = await response.json().catch(() => null);
			setError(apiErrorMessage(t, body, response.status));
		}
	}, [tenantId, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reloadCombinations();
	}, [reloadCombinations]);

	const loadRoster = useCallback(
		async (id: string) => {
			setSectionId(id);
			setRoster(null);
			setError(null);
			if (!id) return;
			const response = await apiFetch(
				`/api/v1/academics/combinations/roster?sectionId=${id}`,
				{ tenantId },
			);
			if (response.ok) {
				setRoster((await response.json()) as RosterDto);
			} else {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
			}
		},
		[tenantId, t],
	);

	async function addPresets() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/academics/combinations/preset", {
				method: "POST",
				tenantId,
				body: JSON.stringify({}),
			});
			const body = (await response.json().catch(() => null)) as {
				created?: number;
				skipped?: number;
				message?: string;
			} | null;
			if (!response.ok) {
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setPresetResult({ created: body?.created ?? 0, skipped: body?.skipped ?? 0 });
			await reloadCombinations();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	async function assign(studentId: string, combinationId: string) {
		if (!roster || !combinationId) return;
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/academics/students/${studentId}/combination`, {
				method: "POST",
				tenantId,
				body: JSON.stringify({ combinationId, academicYearId: roster.academicYearId }),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as {
					code?: string;
					message?: string;
				} | null;
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setRoster({
				...roster,
				students: roster.students.map((s) =>
					s.id === studentId ? { ...s, combinationId } : s,
				),
			});
		} catch {
			setError(t("common.apiUnreachable"));
		}
	}

	return (
		<Card className="shadow-none">
			<CardHeader>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<CardTitle className="text-base">{t("academics.combinations")}</CardTitle>
					{canManage && (
						<Button disabled={pending} onClick={addPresets} size="sm">
							<LayersIcon />
							{pending ? t("common.loading") : t("academics.addCombinations")}
						</Button>
					)}
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{presetResult && (
					<p className="text-sm text-muted-foreground">
						{presetResult.created} {t("academics.combinationsAdded")} {presetResult.skipped}{" "}
						{t("academics.combinationsSkipped")}
					</p>
				)}
				{error && <p className="text-sm text-destructive">{error}</p>}
				{combinations.length === 0 ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						{t("academics.combinationsEmpty")}
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("academics.code")}</TableHead>
								<TableHead>{t("students.name")}</TableHead>
								<TableHead>{t("academics.subjects")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{combinations.map((c) => (
								<TableRow key={c.id}>
									<TableCell className="font-mono text-xs">{c.code}</TableCell>
									<TableCell>{c.name}</TableCell>
									<TableCell className="flex flex-wrap gap-1">
										{c.subjects.map((s) => (
											<Badge key={s.id} variant="outline">
												{s.code}
												{s.isPrincipal ? "" : ` (${t("academics.subsidiary")})`}
											</Badge>
										))}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}

				{canManage && combinations.length > 0 && (
					<div className="flex flex-col gap-3">
						<h3 className="text-sm font-semibold">{t("academics.assignRoster")}</h3>
						{aLevelSections.length === 0 ? (
							<p className="text-sm text-muted-foreground">{t("academics.aLevelOnly")}</p>
						) : (
							<select
								className={selectClass}
								onChange={(e) => void loadRoster(e.target.value)}
								value={sectionId}
							>
								<option value="">{t("academics.pickSection")}</option>
								{aLevelSections.map((s) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
						)}
						{roster &&
							(roster.students.length === 0 ? (
								<p className="text-sm text-muted-foreground">{t("academics.rosterEmpty")}</p>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>{t("students.number")}</TableHead>
											<TableHead>{t("students.name")}</TableHead>
											<TableHead>{t("academics.combination")}</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{roster.students.map((s) => (
											<TableRow key={s.id}>
												<TableCell className="font-mono text-xs">{s.studentNumber}</TableCell>
												<TableCell>{s.name}</TableCell>
												<TableCell>
													<select
														className={selectClass}
														onChange={(e) => void assign(s.id, e.target.value)}
														value={s.combinationId ?? ""}
													>
														<option value="">{t("academics.noCombination")}</option>
														{combinations.map((c) => (
															<option key={c.id} value={c.id}>
																{c.code}
															</option>
														))}
													</select>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

/** Cumulative CA: weighted subject averages across every published assessment of a year. */
function CaSummaryCard({
	tenantId,
	sections,
	years,
	t,
}: {
	tenantId: string;
	sections: SectionOption[];
	years: YearRow[];
	t: Translator;
}) {
	const [sectionId, setSectionId] = useState("");
	const [yearId, setYearId] = useState("");
	const [summary, setSummary] = useState<CaSummaryDto | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function load() {
		if (!sectionId || !yearId) return;
		setPending(true);
		setError(null);
		setSummary(null);
		try {
			const response = await apiFetch(
				`/api/v1/academics/ca-summary?sectionId=${sectionId}&yearId=${yearId}`,
				{ tenantId },
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { code?: string } | null;
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setSummary((await response.json()) as CaSummaryDto);
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	const subjectCodes = summary
		? [...new Set(summary.rows.flatMap((r) => r.subjects.map((s) => s.code)))].sort()
		: [];

	return (
		<Card className="shadow-none">
			<CardHeader>
				<CardTitle className="text-base">{t("academics.caSummary")}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<div className="flex flex-wrap items-center gap-2">
					<select
						className={selectClass}
						onChange={(e) => setSectionId(e.target.value)}
						value={sectionId}
					>
						<option value="">{t("academics.pickSection")}</option>
						{sections.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
					<select
						className={selectClass}
						onChange={(e) => setYearId(e.target.value)}
						value={yearId}
					>
						<option value="">{t("academics.pickYear")}</option>
						{years.map((y) => (
							<option key={y.id} value={y.id}>
								{y.name}
							</option>
						))}
					</select>
					<Button disabled={pending || !sectionId || !yearId} onClick={() => void load()} size="sm">
						{pending ? t("common.loading") : t("academics.load")}
					</Button>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				{summary &&
					(summary.rows.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("academics.caEmpty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("students.number")}</TableHead>
									<TableHead>{t("students.name")}</TableHead>
									{subjectCodes.map((code) => (
										<TableHead className="text-right" key={code}>
											{code}
										</TableHead>
									))}
									<TableHead className="text-right">{t("academics.average")}</TableHead>
									<TableHead className="text-right">{t("academics.rank")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{summary.rows.map((r) => (
									<TableRow key={r.studentId}>
										<TableCell className="font-mono text-xs">{r.studentNumber}</TableCell>
										<TableCell>{r.name}</TableCell>
										{subjectCodes.map((code) => {
											const subject = r.subjects.find((s) => s.code === code);
											return (
												<TableCell className="text-right font-mono" key={code}>
													{subject ? `${subject.marks} ${subject.grade}` : "—"}
												</TableCell>
											);
										})}
										<TableCell className="text-right font-mono">{r.average ?? "—"}</TableCell>
										<TableCell className="text-right font-mono">{r.rank ?? "—"}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					))}
			</CardContent>
		</Card>
	);
}

/** NECTA candidate registration prep: CSV download per section. */
function CandidatesExportCard({
	tenantId,
	sections,
	t,
}: {
	tenantId: string;
	sections: SectionOption[];
	t: Translator;
}) {
	const [sectionId, setSectionId] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [count, setCount] = useState<number | null>(null);

	async function download() {
		if (!sectionId) return;
		setPending(true);
		setError(null);
		setCount(null);
		try {
			const response = await apiFetch(
				`/api/v1/academics/candidates-export?sectionId=${sectionId}`,
				{ tenantId },
			);
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { code?: string } | null;
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			const body = (await response.json()) as {
				section: string;
				candidates: number;
				csv: string;
			};
			setCount(body.candidates);
			const blob = new Blob([body.csv], { type: "text/csv;charset=utf-8" });
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `necta-candidates-${body.section.replace(/\s+/g, "-").toLowerCase()}.csv`;
			anchor.click();
			URL.revokeObjectURL(url);
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Card className="shadow-none">
			<CardHeader>
				<CardTitle className="text-base">{t("academics.nectaExport")}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<select
						className={selectClass}
						onChange={(e) => setSectionId(e.target.value)}
						value={sectionId}
					>
						<option value="">{t("academics.pickSection")}</option>
						{sections.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
					<Button disabled={pending || !sectionId} onClick={() => void download()} size="sm">
						<DownloadIcon />
						{pending ? t("common.loading") : t("academics.downloadCsv")}
					</Button>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				{count !== null && (
					<p className="text-sm text-muted-foreground">
						{t("academics.candidates")}: <span className="font-mono">{count}</span>
					</p>
				)}
			</CardContent>
		</Card>
	);
}
