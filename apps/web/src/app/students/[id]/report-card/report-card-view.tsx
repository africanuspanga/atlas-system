"use client";

import { useEffect, useState } from "react";
import { PrinterIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang, type DictKey } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export interface TermOption {
	id: string;
	name: string;
}

interface ReportSubject {
	subjectId: string;
	code: string;
	name: string;
	nameSw: string | null;
	marks: number;
	grade: string;
	points: number;
}

interface Report {
	student: { id: string; name: string; number: string };
	section: string;
	term: { id: string; name: string };
	educationLevel: string;
	subjects: ReportSubject[];
	average: number | null;
	points: number | null;
	division: string | null;
	position: number | null;
	classSize: number | null;
	attendance: Record<string, number>;
}

const ATTENDANCE_KEYS = ["present", "absent", "late", "excused"] as const;

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring print:hidden";

export function ReportCardView({
	tenantId,
	studentId,
	schoolName,
	terms,
	defaultTermId,
	lang,
}: {
	tenantId: string;
	studentId: string;
	schoolName: string;
	terms: TermOption[];
	defaultTermId: string | null;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [termId, setTermId] = useState<string | null>(defaultTermId);
	const [report, setReport] = useState<Report | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Fetch when the term changes. `ignore` discards a stale response if the
	// user switches terms mid-request, avoiding a flicker to the wrong card.
	useEffect(() => {
		if (!termId) return;
		let ignore = false;
		void (async () => {
			setLoading(true);
			setError(null);
			const response = await apiFetch(
				`/api/v1/assessments/report-card?studentId=${studentId}&termId=${termId}`,
				{ tenantId },
			);
			if (ignore) return;
			setLoading(false);
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
				setReport(null);
				return;
			}
			setReport(await response.json());
		})();
		return () => {
			ignore = true;
		};
	}, [termId, studentId, tenantId]);

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
				<h1 className="text-xl font-semibold">{t("report.title")}</h1>
				<div className="flex items-center gap-2">
					<select
						className={selectClass}
						onChange={(e) => setTermId(e.target.value || null)}
						value={termId ?? ""}
					>
						{terms.map((term) => (
							<option key={term.id} value={term.id}>
								{term.name}
							</option>
						))}
					</select>
					<Button onClick={() => window.print()} size="sm" variant="outline">
						<PrinterIcon /> {t("report.print")}
					</Button>
				</div>
			</div>

			{loading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
			{error && <p className="text-sm text-destructive">{error}</p>}

			{report && !loading && (
				<Card className="shadow-none print:border-none print:shadow-none">
					<CardContent className="flex flex-col gap-4 pt-6">
						<div className="text-center">
							<h2 className="text-lg font-bold uppercase">{schoolName}</h2>
							<p className="font-medium">{t("report.title")}</p>
							<p className="text-sm text-muted-foreground">
								{report.term.name} · {report.section}
							</p>
						</div>

						<div className="flex justify-between text-sm">
							<span className="font-medium">{report.student.name}</span>
							<span className="font-mono">{report.student.number}</span>
						</div>

						{report.subjects.length === 0 ? (
							<p className="py-6 text-center text-sm text-muted-foreground">
								{t("report.noData")}
							</p>
						) : (
							<>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>{t("report.subject")}</TableHead>
											<TableHead className="text-right">{t("assessments.marks")}</TableHead>
											<TableHead className="text-right">{t("assessments.grade")}</TableHead>
											<TableHead className="text-right">{t("report.points")}</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{report.subjects.map((s) => (
											<TableRow key={s.subjectId}>
												<TableCell>
													{lang === "sw" && s.nameSw ? s.nameSw : s.name}
												</TableCell>
												<TableCell className="text-right">{s.marks}</TableCell>
												<TableCell className="text-right font-medium">{s.grade}</TableCell>
												<TableCell className="text-right">{s.points}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>

								<div className="grid grid-cols-2 gap-2 rounded-md border p-3 text-sm sm:grid-cols-4">
									<div>
										<p className="text-muted-foreground">{t("report.average")}</p>
										<p className="font-semibold">{report.average ?? "—"}</p>
									</div>
									<div>
										<p className="text-muted-foreground">{t("report.points")}</p>
										<p className="font-semibold">{report.points ?? "—"}</p>
									</div>
									<div>
										<p className="text-muted-foreground">{t("report.division")}</p>
										<p className="font-semibold">{report.division ?? "—"}</p>
									</div>
									<div>
										<p className="text-muted-foreground">{t("report.position")}</p>
										<p className="font-semibold">
											{report.position
												? `${report.position} ${t("report.of")} ${report.classSize}`
												: "—"}
										</p>
									</div>
								</div>
							</>
						)}

						<div className="text-sm">
							<p className="mb-1 font-medium">{t("report.attendance")}</p>
							<div className="flex flex-wrap gap-3 text-muted-foreground">
								{ATTENDANCE_KEYS.map((key) => (
									<span key={key}>
										{t(`attendance.${key}` as DictKey)}: {report.attendance[key] ?? 0}
									</span>
								))}
							</div>
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
