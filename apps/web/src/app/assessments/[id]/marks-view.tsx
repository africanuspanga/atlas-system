"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export interface AssessmentInfo {
	id: string;
	name: string;
	status: string;
	sectionLabel: string;
	termName: string;
}

export interface SubjectOption {
	id: string;
	code: string;
	name: string;
	name_sw: string | null;
}

export interface StudentRow {
	id: string;
	student_number: string;
	first_name: string;
	middle_name: string | null;
	last_name: string;
}

export interface ScoreRow {
	student_id: string;
	marks: number;
	grade: string;
}

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function MarksView({
	tenantId,
	assessment,
	subjects,
	subjectId,
	roster,
	scores,
	lang,
}: {
	tenantId: string;
	assessment: AssessmentInfo;
	subjects: SubjectOption[];
	subjectId: string | null;
	roster: StudentRow[];
	scores: ScoreRow[];
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [publishPending, setPublishPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [marks, setMarks] = useState<Record<string, string>>(() => {
		const initial: Record<string, string> = {};
		for (const score of scores) initial[score.student_id] = String(score.marks);
		return initial;
	});

	const gradeByStudent: Record<string, string> = {};
	for (const score of scores) gradeByStudent[score.student_id] = score.grade;

	const published = assessment.status === "published";

	async function save() {
		if (!subjectId) return;
		const rows = roster
			.filter((s) => marks[s.id] !== undefined && marks[s.id] !== "")
			.map((s) => ({ studentId: s.id, marks: Number(marks[s.id]) }));
		if (rows.length === 0) return;
		if (rows.some((r) => Number.isNaN(r.marks) || r.marks < 0 || r.marks > 100)) {
			setError("0–100");
			return;
		}
		setPending(true);
		setError(null);
		setMessage(null);
		const response = await apiFetch(`/api/v1/assessments/${assessment.id}/scores`, {
			method: "POST",
			tenantId,
			body: JSON.stringify({ subjectId, rows }),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		setMessage(t("assessments.marksSaved"));
		router.refresh();
	}

	async function publish() {
		setPublishPending(true);
		setError(null);
		const response = await apiFetch(`/api/v1/assessments/${assessment.id}/publish`, {
			method: "POST",
			tenantId,
		});
		setPublishPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		router.refresh();
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h1 className="text-xl font-semibold">{assessment.name}</h1>
					<p className="text-sm text-muted-foreground">
						{assessment.sectionLabel} · {assessment.termName}
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Badge variant={published ? "default" : "outline"}>
						{published ? t("assessments.published") : t("assessments.draft")}
					</Badge>
					{!published && (
						<Button
							disabled={publishPending}
							onClick={() => void publish()}
							size="sm"
							variant="outline"
						>
							{publishPending ? t("common.loading") : t("assessments.publish")}
						</Button>
					)}
				</div>
			</div>

			{!published && (
				<p className="text-sm text-muted-foreground">{t("assessments.publishWarning")}</p>
			)}

			<Card className="shadow-none">
				<CardContent className="flex flex-col gap-3 pt-4">
					<select
						className={`${selectClass} self-start`}
						onChange={(e) => {
							const query = e.target.value ? `?subject=${e.target.value}` : "";
							router.push(`/assessments/${assessment.id}${query}`);
						}}
						value={subjectId ?? ""}
					>
						<option value="">{t("assessments.selectSubject")}</option>
						{subjects.map((s) => (
							<option key={s.id} value={s.id}>
								{s.code} — {lang === "sw" && s.name_sw ? s.name_sw : s.name}
							</option>
						))}
					</select>

					{subjectId && (
						<>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("students.number")}</TableHead>
										<TableHead>{t("students.name")}</TableHead>
										<TableHead className="w-28">{t("assessments.marks")}</TableHead>
										<TableHead className="w-20">{t("assessments.grade")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{roster.map((s) => (
										<TableRow key={s.id}>
											<TableCell className="font-mono text-xs">{s.student_number}</TableCell>
											<TableCell>
												{s.first_name} {s.middle_name ?? ""} {s.last_name}
											</TableCell>
											<TableCell>
												<Input
													className="h-8 w-24"
													disabled={published}
													inputMode="decimal"
													max={100}
													min={0}
													type="number"
													value={marks[s.id] ?? ""}
													onChange={(e) =>
														setMarks((prev) => ({ ...prev, [s.id]: e.target.value }))
													}
												/>
											</TableCell>
											<TableCell>
												{gradeByStudent[s.id] ? (
													<Badge variant="outline">{gradeByStudent[s.id]}</Badge>
												) : (
													"—"
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>

							{error && <p className="text-sm text-destructive">{error}</p>}
							{message && <p className="text-sm font-medium text-primary">{message}</p>}
							{!published && (
								<div className="flex justify-end">
									<Button disabled={pending} onClick={() => void save()}>
										{pending ? t("common.loading") : t("assessments.saveMarks")}
									</Button>
								</div>
							)}
						</>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
