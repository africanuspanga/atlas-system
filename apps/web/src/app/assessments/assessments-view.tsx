"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpenIcon, PlusIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang, type DictKey } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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

export interface SectionOption {
	id: string;
	label: string;
}

export interface TermOption {
	id: string;
	name: string;
}

export interface SubjectRow {
	id: string;
	code: string;
	name: string;
	name_sw: string | null;
	education_level: string;
}

export interface AssessmentRow {
	id: string;
	name: string;
	type: string;
	status: string;
	weight: number;
	class_sections: { name: string; grade_levels: { name: string } | null } | null;
	academic_terms: { name: string } | null;
}

const TYPES = ["test", "midterm", "terminal", "mock", "other"] as const;
const LEVELS = ["primary", "o_level", "a_level"] as const;

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AssessmentsView({
	tenantId,
	assessments,
	sections,
	terms,
	subjects,
	lang,
}: {
	tenantId: string;
	assessments: AssessmentRow[];
	sections: SectionOption[];
	terms: TermOption[];
	subjects: SubjectRow[];
	lang: Lang;
}) {
	const t = getDict(lang);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("assessments.title")}</h1>
				<div className="flex gap-2">
					<SubjectsDialog lang={lang} subjects={subjects} tenantId={tenantId} />
					<CreateAssessmentDialog
						lang={lang}
						sections={sections}
						tenantId={tenantId}
						terms={terms}
					/>
				</div>
			</div>

			<Card className="shadow-none">
				<CardContent className="pt-4">
					{assessments.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							{t("assessments.empty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("assessments.name")}</TableHead>
									<TableHead>{t("students.class")}</TableHead>
									<TableHead>{t("assessments.term")}</TableHead>
									<TableHead>{t("assessments.type")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{assessments.map((a) => (
									<TableRow key={a.id}>
										<TableCell className="font-medium">{a.name}</TableCell>
										<TableCell>
											{a.class_sections
												? `${a.class_sections.grade_levels?.name ?? ""} ${a.class_sections.name}`
												: "—"}
										</TableCell>
										<TableCell>{a.academic_terms?.name ?? "—"}</TableCell>
										<TableCell>{t(`assessments.type.${a.type}` as DictKey)}</TableCell>
										<TableCell>
											<Badge variant={a.status === "published" ? "default" : "outline"}>
												{a.status === "published"
													? t("assessments.published")
													: t("assessments.draft")}
											</Badge>
										</TableCell>
										<TableCell className="text-right">
											<Link
												className="text-sm font-medium text-primary hover:underline"
												href={`/assessments/${a.id}`}
											>
												{t("assessments.enterMarks")}
											</Link>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function CreateAssessmentDialog({
	tenantId,
	sections,
	terms,
	lang,
}: {
	tenantId: string;
	sections: SectionOption[];
	terms: TermOption[];
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [form, setForm] = useState({
		name: "",
		type: "test",
		classSectionId: sections[0]?.id ?? "",
		academicTermId: terms[0]?.id ?? "",
	});

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		const response = await apiFetch("/api/v1/assessments", {
			method: "POST",
			tenantId,
			body: JSON.stringify(form),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		const body = await response.json();
		setOpen(false);
		router.push(`/assessments/${body.assessmentId}`);
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" />}>
				<PlusIcon /> {t("assessments.create")}
			</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("assessments.create")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<Input
						placeholder={t("assessments.name")}
						required
						value={form.name}
						onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
					/>
					<select
						className={selectClass}
						onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}
						value={form.type}
					>
						{TYPES.map((type) => (
							<option key={type} value={type}>
								{t(`assessments.type.${type}` as DictKey)}
							</option>
						))}
					</select>
					<select
						className={selectClass}
						onChange={(e) => setForm((f) => ({ ...f, classSectionId: e.target.value }))}
						required
						value={form.classSectionId}
					>
						{sections.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
					<select
						className={selectClass}
						onChange={(e) => setForm((f) => ({ ...f, academicTermId: e.target.value }))}
						required
						value={form.academicTermId}
					>
						{terms.map((term) => (
							<option key={term.id} value={term.id}>
								{term.name}
							</option>
						))}
					</select>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
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

function SubjectsDialog({
	tenantId,
	subjects,
	lang,
}: {
	tenantId: string;
	subjects: SubjectRow[];
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [level, setLevel] = useState<string>("o_level");

	async function addPresets() {
		setPending(true);
		setError(null);
		setMessage(null);
		const response = await apiFetch("/api/v1/subjects/preset", {
			method: "POST",
			tenantId,
			body: JSON.stringify({ educationLevel: level }),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		const body = await response.json();
		setMessage(`${body.created} ${t("assessments.presetsAdded")}`);
		router.refresh();
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				<BookOpenIcon /> {t("assessments.subjects")}
			</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("assessments.subjects")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					{subjects.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("assessments.subjectsEmpty")}</p>
					) : (
						<div className="max-h-56 overflow-y-auto rounded-md border">
							<Table>
								<TableBody>
									{subjects.map((s) => (
										<TableRow key={s.id}>
											<TableCell className="font-mono text-xs">{s.code}</TableCell>
											<TableCell>{lang === "sw" && s.name_sw ? s.name_sw : s.name}</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{s.education_level}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
					<div className="flex items-center gap-2">
						<select
							className={selectClass}
							onChange={(e) => setLevel(e.target.value)}
							value={level}
						>
							{LEVELS.map((l) => (
								<option key={l} value={l}>
									{l}
								</option>
							))}
						</select>
						<Button disabled={pending} onClick={() => void addPresets()} size="sm">
							{pending ? t("common.loading") : t("assessments.addPresets")}
						</Button>
					</div>
					{message && <p className="text-sm font-medium text-primary">{message}</p>}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
