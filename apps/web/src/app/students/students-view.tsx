"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import { PlusIcon, UploadIcon, DownloadIcon, SearchIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { createClient } from "@/lib/supabase/client";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type DictKey } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
import { Card, CardContent } from "@/components/ui/card";

export interface SectionOption {
	id: string;
	label: string;
	/** grade_levels.sequence — used for the reading order of the picker. */
	gradeSequence: number;
	academicYearId: string;
	yearName: string;
	yearStartsOn: string;
}

export interface StudentListRow {
	id: string;
	student_number: string;
	first_name: string;
	middle_name: string | null;
	last_name: string;
	status: string;
	class_enrolments: Array<{
		id: string;
		status: string;
		academic_year_id: string;
		class_sections: {
			id: string;
			name: string;
			grade_levels: { name: string } | null;
		} | null;
	}>;
	student_guardians: Array<{
		is_primary: boolean;
		guardians: {
			id: string;
			full_name: string;
			phone: string | null;
			email: string | null;
			user_id: string | null;
		} | null;
	}>;
}

// Import-file contract: these header names are parsed back verbatim by
// sheet_to_json → RawRow in handleFile(). Do NOT translate them.
const TEMPLATE_HEADERS = [
	"firstName",
	"middleName",
	"lastName",
	"gender",
	"dateOfBirth",
	"boardingStatus",
	"className",
	"stream",
	"guardianName",
	"guardianPhone",
	"guardianEmail",
	"guardianRelationship",
];

const TEMPLATE_EXAMPLE = [
	"Neema",
	"J",
	"Joseph",
	"female",
	"2012-03-14",
	"day",
	"Form 1",
	"A",
	"Mary Joseph",
	"+255700000001",
	"mary@example.com",
	"mother",
];

interface RawRow {
	firstName?: string;
	middleName?: string;
	lastName?: string;
	gender?: string;
	dateOfBirth?: string;
	boardingStatus?: string;
	className?: string;
	stream?: string;
	guardianName?: string;
	guardianPhone?: string;
	guardianEmail?: string;
	guardianRelationship?: string;
}

function toImportRow(raw: RawRow) {
	const clean = (v: unknown) => {
		const s = String(v ?? "").trim();
		return s === "" ? undefined : s;
	};
	return {
		firstName: clean(raw.firstName) ?? "",
		middleName: clean(raw.middleName),
		lastName: clean(raw.lastName) ?? "",
		gender: (clean(raw.gender)?.toLowerCase() ?? "") as "male" | "female",
		dateOfBirth: clean(raw.dateOfBirth),
		boardingStatus: (clean(raw.boardingStatus)?.toLowerCase() ?? "day") as "day" | "boarding",
		className: clean(raw.className),
		stream: clean(raw.stream),
		guardian: clean(raw.guardianName)
			? {
					fullName: clean(raw.guardianName) ?? "",
					phone: clean(raw.guardianPhone),
					email: clean(raw.guardianEmail),
					relationship: (clean(raw.guardianRelationship)?.toLowerCase() ?? "guardian") as
						| "mother"
						| "father"
						| "guardian"
						| "sponsor"
						| "other",
				}
			: undefined,
	};
}

// Keep in sync with the first-paint fetch in ./page.tsx (server component —
// it cannot import runtime values from this "use client" module).
const STUDENTS_PAGE_SIZE = 50;

const STUDENT_LIST_SELECT = `id, student_number, first_name, middle_name, last_name, status,
	 class_enrolments(id, status, academic_year_id,
		 class_sections(id, name, grade_levels(name))),
	 student_guardians(is_primary, guardians(id, full_name, phone, email, user_id))`;

/** students.status values app.set_student_status accepts, in menu order. */
const STUDENT_STATUSES = [
	"active",
	"transferred",
	"withdrawn",
	"graduated",
	"archived",
] as const;

type StudentStatus = (typeof STUDENT_STATUSES)[number];

const STATUS_KEYS: Record<string, DictKey> = {
	active: "students.status.active",
	transferred: "students.status.transferred",
	withdrawn: "students.status.withdrawn",
	graduated: "students.status.graduated",
	archived: "students.status.archived",
};

function normaliseStatus(value: string): StudentStatus {
	return (STUDENT_STATUSES as readonly string[]).includes(value)
		? (value as StudentStatus)
		: "active";
}

/** A pupil holds at most one live placement — past years close to left/completed. */
function activeEnrolment(student: StudentListRow) {
	return student.class_enrolments.find((e) => e.status === "active");
}

function enrolmentLabel(student: StudentListRow) {
	const section = activeEnrolment(student)?.class_sections;
	if (!section) return null;
	return `${section.grade_levels?.name ?? ""} ${section.name}`.trim();
}

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Row-action affordance — matches the invite/report-card links in the table. */
const rowActionClass =
	"text-sm font-medium text-muted-foreground hover:text-primary hover:underline";

/** PostgREST `.or()` filters break on commas/parens/percent — strip them. */
function sanitizeSearch(value: string) {
	return value.replace(/[,()%\\]/g, " ").trim();
}

export function StudentsView({
	tenantId,
	students,
	total,
	sections,
	canUpdate,
	canArchive,
}: {
	tenantId: string;
	students: StudentListRow[];
	total: number;
	sections: SectionOption[];
	/** students.update — required for both lifecycle actions. */
	canUpdate: boolean;
	/** students.archive — additionally required for the terminal statuses. */
	canArchive: boolean;
}) {
	const t = getDict();
	const [rows, setRows] = useState<StudentListRow[]>(students);
	const [count, setCount] = useState(total);
	const [page, setPage] = useState(0);
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState(""); // debounced
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const firstRun = useRef(true);

	// Debounce keystrokes → search term; reset to the first page.
	useEffect(() => {
		const handle = setTimeout(() => {
			setSearch(query);
			setPage(0);
		}, 300);
		return () => clearTimeout(handle);
	}, [query]);

	const reload = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		const supabase = createClient();
		let builder = supabase
			.from("students")
			.select(STUDENT_LIST_SELECT, { count: "exact" })
			.eq("tenant_id", tenantId);
		const q = sanitizeSearch(search);
		if (q) {
			// Server-side filter: name parts + admission number (string — keeps
			// leading zeros).
			builder = builder.or(
				`first_name.ilike.%${q}%,middle_name.ilike.%${q}%,last_name.ilike.%${q}%,student_number.ilike.%${q}%`,
			);
		}
		const { data, count: exact, error } = await builder
			.order("created_at", { ascending: false })
			.range(page * STUDENTS_PAGE_SIZE, page * STUDENTS_PAGE_SIZE + STUDENTS_PAGE_SIZE - 1);
		if (error) {
			setLoadError(t("err.server"));
		} else {
			setRows((data ?? []) as unknown as StudentListRow[]);
			setCount(exact ?? 0);
		}
		setLoading(false);
	}, [tenantId, search, page, t]);

	useEffect(() => {
		// The server page provides the first page for first paint — only fetch
		// once search/pagination actually change.
		if (firstRun.current) {
			firstRun.current = false;
			return;
		}
		void reload();
	}, [reload]);

	// Add/import dialogs call router.refresh(), which re-delivers fresh page-0
	// props — adopt them (render-time derived state) unless the user has
	// searched or paged away.
	const [prevStudents, setPrevStudents] = useState(students);
	if (prevStudents !== students) {
		setPrevStudents(students);
		if (search === "" && page === 0) {
			setRows(students);
			setCount(total);
		}
	}

	const totalPages = Math.max(1, Math.ceil(count / STUDENTS_PAGE_SIZE));

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("students.title")}</h1>
				<div className="flex gap-2">
					<ImportDialog tenantId={tenantId} />
					<AddStudentDialog sections={sections} tenantId={tenantId} />
				</div>
			</div>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="relative w-full max-w-sm">
					<SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						className="pl-9"
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("students.search")}
						type="search"
						value={query}
					/>
				</div>
				<p className="text-sm text-muted-foreground">
					<span className="font-mono">{count}</span> {t("students.total")}
				</p>
			</div>

			{loadError && <p className="text-sm text-destructive">{loadError}</p>}

			{loading ? (
				<ListSkeleton rows={8} />
			) : (
				<Card className="shadow-none">
					<CardContent className="pt-4">
						{rows.length === 0 ? (
							<p className="py-10 text-center text-sm text-muted-foreground">
								{search ? t("students.noMatches") : t("students.empty")}
							</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("students.number")}</TableHead>
										<TableHead>{t("students.name")}</TableHead>
										<TableHead>{t("students.class")}</TableHead>
										<TableHead>{t("students.guardian")}</TableHead>
										<TableHead>{t("students.status")}</TableHead>
										<TableHead />
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((s) => {
									const placement = enrolmentLabel(s);
									const guardian =
										s.student_guardians.find((g) => g.is_primary)?.guardians ??
										s.student_guardians[0]?.guardians;
									return (
										<TableRow key={s.id}>
											<TableCell className="font-mono text-xs">{s.student_number}</TableCell>
											<TableCell>
												{s.first_name} {s.middle_name ?? ""} {s.last_name}
											</TableCell>
											<TableCell>{placement ?? "—"}</TableCell>
											<TableCell>
												{guardian ? `${guardian.full_name} ${guardian.phone ?? ""}` : "—"}
											</TableCell>
											<TableCell>
												<Badge variant="outline">
													{STATUS_KEYS[s.status] ? t(STATUS_KEYS[s.status]) : s.status}
												</Badge>
											</TableCell>
											<TableCell className="text-right">
												<span className="flex items-center justify-end gap-3">
													{guardian?.email && !guardian.user_id && (
														<InviteParentButton
															guardianId={guardian.id}
															tenantId={tenantId}
														/>
													)}
													{canUpdate && (
														<>
															<ClassPlacementDialog
																onDone={reload}
																sections={sections}
																student={s}
																tenantId={tenantId}
															/>
															<StudentStatusDialog
																canArchive={canArchive}
																onDone={reload}
																student={s}
																tenantId={tenantId}
															/>
														</>
													)}
													<Link
														className="text-sm font-medium text-primary hover:underline"
														href={`/students/${s.id}/report-card`}
													>
														{t("students.reportCard")}
													</Link>
												</span>
											</TableCell>
										</TableRow>
									);
								})}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			)}

			{totalPages > 1 && (
				<div className="flex items-center justify-end gap-2">
					<Button
						disabled={page === 0 || loading}
						onClick={() => setPage((p) => Math.max(0, p - 1))}
						size="sm"
						variant="outline"
					>
						{t("common.prev")}
					</Button>
					<span className="font-mono text-sm text-muted-foreground">
						{page + 1} {t("report.of")} {totalPages}
					</span>
					<Button
						disabled={page >= totalPages - 1 || loading}
						onClick={() => setPage((p) => p + 1)}
						size="sm"
						variant="outline"
					>
						{t("common.next")}
					</Button>
				</div>
			)}
		</div>
	);
}

function InviteParentButton({
	tenantId,
	guardianId,
}: {
	tenantId: string;
	guardianId: string;
}) {
	const t = getDict();
	const [pending, setPending] = useState(false);
	const [link, setLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function invite() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/guardians/${guardianId}/invite`, {
				method: "POST",
				tenantId,
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			const body = await response.json();
			setLink(body.inviteUrl);
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	if (error) return <span className="text-xs text-destructive">{error}</span>;
	if (link) {
		return (
			<button
				className="text-sm font-medium text-primary hover:underline"
				onClick={() => {
					void navigator.clipboard.writeText(link);
					setCopied(true);
				}}
				type="button"
			>
				{copied ? t("common.copied") : t("common.copy")}
			</button>
		);
	}
	return (
		<button
			className="text-sm font-medium text-muted-foreground hover:text-primary hover:underline"
			disabled={pending}
			onClick={() => void invite()}
			type="button"
		>
			{pending ? t("common.loading") : t("students.inviteParent")}
		</button>
	);
}

/**
 * Class placement — migration 0030. `class_enrolments` used to be insert-only
 * behind `unique (student_id, academic_year_id)`, so a mistyped stream was
 * permanent for the whole year and the pupil never appeared on their real
 * register. One dialog covers both "assign" and "move".
 */
function ClassPlacementDialog({
	tenantId,
	student,
	sections,
	onDone,
}: {
	tenantId: string;
	student: StudentListRow;
	sections: SectionOption[];
	onDone: () => Promise<void>;
}) {
	const t = getDict();
	const current = activeEnrolment(student)?.class_sections ?? null;
	const [open, setOpen] = useState(false);
	const [sectionId, setSectionId] = useState(current?.id ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset on open AND on close: a reopened dialog must never inherit a prior
	// selection, nor a placement that the last list reload has since changed.
	function handleOpenChange(next: boolean) {
		setSectionId(current?.id ?? "");
		setError(null);
		setPending(false);
		setOpen(next);
	}

	// Group by academic year (the server already ordered newest year first) so
	// rolling a pupil into next year's stream is one obvious choice.
	const groups: Array<{ id: string; name: string; options: SectionOption[] }> = [];
	for (const section of sections) {
		const bucket = groups.find((g) => g.id === section.academicYearId);
		if (bucket) bucket.options.push(section);
		else
			groups.push({
				id: section.academicYearId,
				name: section.yearName,
				options: [section],
			});
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (pending || !sectionId) return;
		setPending(true);
		setError(null);
		let ok = false;
		try {
			// academicYearId is deliberately omitted: the RPC defaults to the
			// section's own year, so a pupil can never be filed into a section
			// belonging to a different year.
			const response = await apiFetch(`/api/v1/students/${student.id}/enrolment`, {
				method: "PATCH",
				tenantId,
				body: JSON.stringify({ classSectionId: sectionId }),
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
			await onDone();
		}
	}

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger className={rowActionClass}>{t("students.changeClass")}</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("students.class.title")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<p className="font-medium">
						{student.first_name} {student.last_name}{" "}
						<span className="font-mono text-xs text-muted-foreground">
							{student.student_number}
						</span>
					</p>
					<p className="text-sm text-muted-foreground">
						{t("students.class.current")}:{" "}
						<span className="font-medium text-foreground">
							{enrolmentLabel(student) ?? t("students.class.none")}
						</span>
					</p>
					{sections.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("students.class.noSections")}</p>
					) : (
						<label className="flex flex-col gap-1 text-sm text-muted-foreground">
							{t("students.class.moveTo")}
							<select
								className={selectClass}
								onChange={(e) => setSectionId(e.target.value)}
								value={sectionId}
							>
								<option value="">{t("students.class.pick")}</option>
								{groups.map((group) => (
									<optgroup key={group.id} label={group.name}>
										{group.options.map((option) => (
											<option key={option.id} value={option.id}>
												{option.label}
											</option>
										))}
									</optgroup>
								))}
							</select>
						</label>
					)}
					<p className="text-xs text-muted-foreground">{t("students.class.explain")}</p>
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
						<Button
							disabled={pending || sectionId === "" || sectionId === (current?.id ?? "")}
							type="submit"
						>
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Student lifecycle — migration 0030. `students.status` had no writer at all,
 * so a leaver held a paid plan seat forever, kept being invoiced and kept
 * getting absence SMS. Terminal statuses additionally need `students.archive`;
 * the API enforces that too, this only mirrors it in the UI.
 */
function StudentStatusDialog({
	tenantId,
	student,
	canArchive,
	onDone,
}: {
	tenantId: string;
	student: StudentListRow;
	canArchive: boolean;
	onDone: () => Promise<void>;
}) {
	const t = getDict();
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<StudentStatus>(normaliseStatus(student.status));
	const [reason, setReason] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function handleOpenChange(next: boolean) {
		setStatus(normaliseStatus(student.status));
		setReason("");
		setError(null);
		setPending(false);
		setOpen(next);
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (pending || status === student.status) return;
		setPending(true);
		setError(null);
		let ok = false;
		try {
			const response = await apiFetch(`/api/v1/students/${student.id}/status`, {
				method: "PATCH",
				tenantId,
				body: JSON.stringify({ status, reason: reason.trim() || undefined }),
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
			await onDone();
		}
	}

	const currentKey = STATUS_KEYS[student.status];

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger className={rowActionClass}>{t("students.changeStatus")}</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("students.status.title")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<p className="font-medium">
						{student.first_name} {student.last_name}{" "}
						<span className="font-mono text-xs text-muted-foreground">
							{student.student_number}
						</span>
					</p>
					<p className="text-sm text-muted-foreground">
						{t("students.status.current")}:{" "}
						<span className="font-medium text-foreground">
							{currentKey ? t(currentKey) : student.status}
						</span>
					</p>
					<label className="flex flex-col gap-1 text-sm text-muted-foreground">
						{t("students.status.new")}
						<select
							className={selectClass}
							onChange={(e) => setStatus(normaliseStatus(e.target.value))}
							value={status}
						>
							{STUDENT_STATUSES.map((value) => (
								<option disabled={value !== "active" && !canArchive} key={value} value={value}>
									{t(STATUS_KEYS[value])}
								</option>
							))}
						</select>
					</label>
					{!canArchive && (
						<p className="text-xs text-muted-foreground">{t("students.status.needArchive")}</p>
					)}
					<label className="flex flex-col gap-1 text-sm text-muted-foreground">
						{t("students.status.reason")}
						<textarea
							className="min-h-20 rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
							maxLength={500}
							onChange={(e) => setReason(e.target.value)}
							placeholder={t("students.status.reasonPlaceholder")}
							value={reason}
						/>
					</label>
					{status !== "active" && (
						<div className="rounded-xl border p-3 text-xs text-muted-foreground">
							<p className="font-medium text-foreground">{t("students.status.effects")}</p>
							<ul className="mt-1 list-disc pl-4">
								<li>{t("students.status.effectSeat")}</li>
								<li>{t("students.status.effectInvoices")}</li>
								<li>{t("students.status.effectSms")}</li>
								<li>{t("students.status.effectRegister")}</li>
							</ul>
						</div>
					)}
					{status === "active" && student.status !== "active" && (
						<p className="text-xs text-muted-foreground">
							{t("students.status.reinstateNote")}
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
							{t("common.cancel")}
						</Button>
						<Button disabled={pending || status === student.status} type="submit">
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function AddStudentDialog({
	tenantId,
	sections,
}: {
	tenantId: string;
	sections: SectionOption[];
}) {
	const t = getDict();
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [form, setForm] = useState({
		firstName: "",
		middleName: "",
		lastName: "",
		gender: "female",
		dateOfBirth: "",
		boardingStatus: "day",
		classSectionId: "",
		guardianName: "",
		guardianPhone: "",
		guardianEmail: "",
		relationship: "guardian",
	});

	function set(field: string, value: string) {
		setForm((f) => ({ ...f, [field]: value }));
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/students", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					firstName: form.firstName,
					middleName: form.middleName || undefined,
					lastName: form.lastName,
					gender: form.gender,
					dateOfBirth: form.dateOfBirth || undefined,
					boardingStatus: form.boardingStatus,
					classSectionId: form.classSectionId || undefined,
					guardian: form.guardianName
						? {
								fullName: form.guardianName,
								phone: form.guardianPhone || undefined,
								email: form.guardianEmail || undefined,
								relationship: form.relationship,
							}
						: undefined,
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setOpen(false);
			router.refresh();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" />}>
				<PlusIcon /> {t("students.add")}
			</DialogTrigger>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("students.add")}</DialogTitle>
				</DialogHeader>
				<form className="grid grid-cols-2 gap-3" onSubmit={submit}>
					<Input
						placeholder={t("students.firstName")}
						required
						value={form.firstName}
						onChange={(e) => set("firstName", e.target.value)}
					/>
					<Input
						placeholder={t("students.lastName")}
						required
						value={form.lastName}
						onChange={(e) => set("lastName", e.target.value)}
					/>
					<select
						className={selectClass}
						onChange={(e) => set("gender", e.target.value)}
						value={form.gender}
					>
						<option value="female">{t("students.female")}</option>
						<option value="male">{t("students.male")}</option>
					</select>
					<Input
						type="date"
						value={form.dateOfBirth}
						onChange={(e) => set("dateOfBirth", e.target.value)}
					/>
					<select
						className={selectClass}
						onChange={(e) => set("boardingStatus", e.target.value)}
						value={form.boardingStatus}
					>
						<option value="day">{t("students.day")}</option>
						<option value="boarding">{t("students.boarding")}</option>
					</select>
					<select
						className={selectClass}
						onChange={(e) => set("classSectionId", e.target.value)}
						value={form.classSectionId}
					>
						<option value="">{t("students.class")} —</option>
						{sections.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
					<Input
						className="col-span-2"
						placeholder={t("students.guardianName")}
						value={form.guardianName}
						onChange={(e) => set("guardianName", e.target.value)}
					/>
					<Input
						placeholder={t("students.guardianPhone")}
						value={form.guardianPhone}
						onChange={(e) => set("guardianPhone", e.target.value)}
					/>
					<Input
						className="col-span-2"
						placeholder={t("students.guardianEmail")}
						type="email"
						value={form.guardianEmail}
						onChange={(e) => set("guardianEmail", e.target.value)}
					/>
					<select
						className={selectClass}
						onChange={(e) => set("relationship", e.target.value)}
						value={form.relationship}
					>
						<option value="mother">{t("students.rel.mother")}</option>
						<option value="father">{t("students.rel.father")}</option>
						<option value="guardian">{t("students.rel.guardian")}</option>
						<option value="sponsor">{t("students.rel.sponsor")}</option>
					</select>
					{error && <p className="col-span-2 text-sm text-destructive">{error}</p>}
					<div className="col-span-2 flex justify-end gap-2">
						<Button onClick={() => setOpen(false)} type="button" variant="outline">
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

function ImportDialog({ tenantId }: { tenantId: string }) {
	const t = getDict();
	const router = useRouter();
	const fileRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [rows, setRows] = useState<ReturnType<typeof toImportRow>[]>([]);
	const [report, setReport] = useState<{
		valid: number;
		invalid: number;
		errors: Array<{ row: number; message: string }>;
	} | null>(null);
	const [done, setDone] = useState<number | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function downloadTemplate() {
		const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, TEMPLATE_EXAMPLE]);
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, ws, "Students");
		XLSX.writeFile(wb, "atlas-students-template.xlsx");
	}

	async function handleFile(file: File) {
		setError(null);
		setReport(null);
		setDone(null);
		const buffer = await file.arrayBuffer();
		const workbook = XLSX.read(buffer);
		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		const raw = XLSX.utils.sheet_to_json<RawRow>(sheet, { raw: false });
		setRows(raw.map(toImportRow));
	}

	async function run(dryRun: boolean) {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/students/import", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ rows, dryRun }),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			if (body.dryRun) {
				setReport(body);
			} else {
				setDone(body.imported);
				setReport(null);
				router.refresh();
			}
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				<UploadIcon /> {t("students.import")}
			</DialogTrigger>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("students.import")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<Button className="self-start" onClick={downloadTemplate} size="sm" variant="outline">
						<DownloadIcon /> {t("students.template")}
					</Button>
					<Input
						accept=".xlsx,.xls,.csv"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void handleFile(file);
						}}
						ref={fileRef}
						type="file"
					/>
					{rows.length > 0 && (
						<p className="text-sm text-muted-foreground">
							{rows.length} {t("students.rowsLoaded")}
						</p>
					)}
					{report && (
						<div className="rounded-md border p-3 text-sm">
							<p>
								{report.valid} {t("students.rowsValid")} · {report.invalid}{" "}
								{t("students.rowsInvalid")}
							</p>
							{report.errors.slice(0, 8).map((e) => (
								<p className="text-destructive" key={`${e.row}-${e.message}`}>
									{t("students.row")} {e.row}: {e.message}
								</p>
							))}
						</div>
					)}
					{done !== null && (
						<p className="text-sm font-medium text-primary">
							{done} {t("students.importDone")}
						</p>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button
							disabled={rows.length === 0 || pending}
							onClick={() => void run(true)}
							variant="outline"
						>
							{t("students.validate")}
						</Button>
						<Button
							disabled={pending || !report || report.invalid > 0}
							onClick={() => void run(false)}
						>
							{pending ? t("common.loading") : t("students.importAll")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
