"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as XLSX from "xlsx";
import { PlusIcon, UploadIcon, DownloadIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang } from "@/i18n";
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
}

export interface StudentListRow {
	id: string;
	student_number: string;
	first_name: string;
	middle_name: string | null;
	last_name: string;
	status: string;
	class_enrolments: Array<{
		class_sections: { name: string; grade_levels: { name: string } | null } | null;
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

export function StudentsView({
	tenantId,
	students,
	sections,
	lang,
}: {
	tenantId: string;
	students: StudentListRow[];
	sections: SectionOption[];
	lang: Lang;
}) {
	const t = getDict(lang);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("students.title")}</h1>
				<div className="flex gap-2">
					<ImportDialog lang={lang} tenantId={tenantId} />
					<AddStudentDialog lang={lang} sections={sections} tenantId={tenantId} />
				</div>
			</div>

			<Card className="shadow-none">
				<CardContent className="pt-4">
					{students.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							{t("students.empty")}
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
								{students.map((s) => {
									const section = s.class_enrolments[0]?.class_sections;
									const guardian =
										s.student_guardians.find((g) => g.is_primary)?.guardians ??
										s.student_guardians[0]?.guardians;
									return (
										<TableRow key={s.id}>
											<TableCell className="font-mono text-xs">{s.student_number}</TableCell>
											<TableCell>
												{s.first_name} {s.middle_name ?? ""} {s.last_name}
											</TableCell>
											<TableCell>
												{section ? `${section.grade_levels?.name ?? ""} ${section.name}` : "—"}
											</TableCell>
											<TableCell>
												{guardian ? `${guardian.full_name} ${guardian.phone ?? ""}` : "—"}
											</TableCell>
											<TableCell>
												<Badge variant="outline">{s.status}</Badge>
											</TableCell>
											<TableCell className="text-right">
												<span className="flex items-center justify-end gap-3">
													{guardian?.email && !guardian.user_id && (
														<InviteParentButton
															guardianId={guardian.id}
															lang={lang}
															tenantId={tenantId}
														/>
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
		</div>
	);
}

function InviteParentButton({
	tenantId,
	guardianId,
	lang,
}: {
	tenantId: string;
	guardianId: string;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [pending, setPending] = useState(false);
	const [link, setLink] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function invite() {
		setPending(true);
		setError(null);
		const response = await apiFetch(`/api/v1/guardians/${guardianId}/invite`, {
			method: "POST",
			tenantId,
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.code ?? `HTTP ${response.status}`);
			return;
		}
		const body = await response.json();
		setLink(body.inviteUrl);
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

function AddStudentDialog({
	tenantId,
	sections,
	lang,
}: {
	tenantId: string;
	sections: SectionOption[];
	lang: Lang;
}) {
	const t = getDict(lang);
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
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		setOpen(false);
		router.refresh();
	}

	const selectClass =
		"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
						<option value="mother">Mama / Mother</option>
						<option value="father">Baba / Father</option>
						<option value="guardian">Mlezi / Guardian</option>
						<option value="sponsor">Mfadhili / Sponsor</option>
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

function ImportDialog({ tenantId, lang }: { tenantId: string; lang: Lang }) {
	const t = getDict(lang);
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
		const response = await apiFetch("/api/v1/students/import", {
			method: "POST",
			tenantId,
			body: JSON.stringify({ rows, dryRun }),
		});
		setPending(false);
		const body = await response.json().catch(() => null);
		if (!response.ok) {
			setError(body?.message ?? JSON.stringify(body?.issues?.slice(0, 3)) ?? "Failed");
			return;
		}
		if (body.dryRun) {
			setReport(body);
		} else {
			setDone(body.imported);
			setReport(null);
			router.refresh();
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
						<p className="text-sm text-muted-foreground">{rows.length} rows loaded.</p>
					)}
					{report && (
						<div className="rounded-md border p-3 text-sm">
							<p>
								{report.valid} {t("students.rowsValid")} · {report.invalid}{" "}
								{t("students.rowsInvalid")}
							</p>
							{report.errors.slice(0, 8).map((e) => (
								<p className="text-destructive" key={`${e.row}-${e.message}`}>
									Row {e.row}: {e.message}
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
