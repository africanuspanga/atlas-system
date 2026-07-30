"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DownloadIcon, LayersIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { getDict, type DictKey, type Lang, type Translator } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
	grade_levels: { name: string; sequence: number; education_level: string } | null;
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
	canManageCombinations,
	canExport,
	lang,
}: {
	subjects: SubjectRow[];
	gradeLevels: GradeLevelRow[];
	sections: SectionRow[];
	years: YearRow[];
	tenantId: string;
	canManageCombinations: boolean;
	canExport: boolean;
	lang: Lang;
}) {
	const t = useMemo(() => getDict(lang), [lang]);
	const levelLabel = (level: string) => {
		const key = LEVEL_KEYS[level];
		return key ? t(key) : level;
	};

	const sortedSections = [...sections].sort(
		(a, b) =>
			(a.grade_levels?.sequence ?? 99) - (b.grade_levels?.sequence ?? 99) ||
			a.name.localeCompare(b.name),
	);
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
					<CardTitle className="text-base">{t("academics.years")}</CardTitle>
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
					<CardTitle className="text-base">{t("academics.sections")}</CardTitle>
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
					<CardTitle className="text-base">{t("academics.gradeLevels")}</CardTitle>
				</CardHeader>
				<CardContent>
					{gradeLevels.length === 0 ? (
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
								{gradeLevels.map((g) => (
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
									<TableHead>{t("academics.nameSw")}</TableHead>
									<TableHead>{t("academics.level")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{subjects.map((s) => (
									<TableRow key={s.id}>
										<TableCell className="font-mono text-xs">{s.code}</TableCell>
										<TableCell>{s.name}</TableCell>
										<TableCell>{s.name_sw ?? "—"}</TableCell>
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
