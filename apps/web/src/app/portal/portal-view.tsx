"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang, type DictKey } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

interface Child {
	studentId: string;
	school: string;
	name: string;
	number: string;
	className: string | null;
	balance: number;
	attendance: Record<string, number>;
	terms: Array<{ id: string; name: string }>;
}

interface ReportSubject {
	subjectId: string;
	name: string;
	nameSw: string | null;
	marks: number;
	grade: string;
	points: number;
}

interface Report {
	subjects: ReportSubject[];
	average: number | null;
	points: number | null;
	division: string | null;
	position: number | null;
	classSize: number | null;
}

const ATTENDANCE_KEYS = ["present", "absent", "late", "excused"] as const;

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

function fmtTZS(amount: number) {
	return `${amount.toLocaleString("en-US")} TZS`;
}

export function PortalView({ lang }: { lang: Lang }) {
	const t = getDict(lang);
	const [children, setChildren] = useState<Child[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		void (async () => {
			const response = await apiFetch("/api/v1/portal/children");
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(body?.code ?? `HTTP ${response.status}`);
				return;
			}
			const body = await response.json();
			setChildren(body.children);
		})();
	}, []);

	if (error === "PORTAL_NOT_LINKED") {
		return (
			<Card className="shadow-none">
				<CardContent className="py-10 text-center text-sm text-muted-foreground">
					{t("portal.notLinked")}
				</CardContent>
			</Card>
		);
	}
	if (error) return <p className="text-sm text-destructive">{error}</p>;
	if (!children) return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;

	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">{t("portal.children")}</h1>
			{children.map((child) => (
				<ChildCard child={child} key={child.studentId} lang={lang} />
			))}
		</div>
	);
}

function ChildCard({ child, lang }: { child: Child; lang: Lang }) {
	const t = getDict(lang);
	const [termId, setTermId] = useState(child.terms.at(-1)?.id ?? "");
	const [report, setReport] = useState<Report | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function loadReport() {
		if (!termId) return;
		setLoading(true);
		setError(null);
		const response = await apiFetch(
			`/api/v1/portal/children/${child.studentId}/report-card?termId=${termId}`,
		);
		setLoading(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		setReport(await response.json());
	}

	return (
		<Card className="shadow-none">
			<CardHeader>
				<CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
					<span>
						{child.name}{" "}
						<span className="font-mono text-xs text-muted-foreground">{child.number}</span>
					</span>
					<Badge variant="outline">
						{child.className ?? "—"} · {child.school}
					</Badge>
				</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col gap-3">
				<div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
					<div>
						<p className="text-muted-foreground">{t("finance.balance")}</p>
						<p className="font-semibold">{fmtTZS(child.balance)}</p>
					</div>
					<div className="col-span-2">
						<p className="text-muted-foreground">{t("report.attendance")}</p>
						<p className="font-medium">
							{ATTENDANCE_KEYS.map(
								(key) =>
									`${t(`attendance.${key}` as DictKey)}: ${child.attendance[key] ?? 0}`,
							).join(" · ")}
						</p>
					</div>
				</div>

				<div className="flex items-center gap-2">
					<select
						className={selectClass}
						onChange={(e) => {
							setTermId(e.target.value);
							setReport(null);
						}}
						value={termId}
					>
						{child.terms.map((term) => (
							<option key={term.id} value={term.id}>
								{term.name}
							</option>
						))}
					</select>
					<button
						className="rounded-md border border-input px-3 py-2 text-sm font-medium hover:bg-muted"
						disabled={loading || !termId}
						onClick={() => void loadReport()}
						type="button"
					>
						{loading ? t("common.loading") : t("portal.viewReport")}
					</button>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}

				{report &&
					(report.subjects.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("report.noData")}</p>
					) : (
						<>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("report.subject")}</TableHead>
										<TableHead className="text-right">{t("assessments.marks")}</TableHead>
										<TableHead className="text-right">{t("assessments.grade")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{report.subjects.map((subject) => (
										<TableRow key={subject.subjectId}>
											<TableCell>
												{lang === "sw" && subject.nameSw ? subject.nameSw : subject.name}
											</TableCell>
											<TableCell className="text-right">{subject.marks}</TableCell>
											<TableCell className="text-right font-medium">
												{subject.grade}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
							<div className="flex flex-wrap gap-3 text-sm">
								<span>
									{t("report.average")}: <strong>{report.average ?? "—"}</strong>
								</span>
								<span>
									{t("report.division")}: <strong>{report.division ?? "—"}</strong>
								</span>
								<span>
									{t("report.position")}:{" "}
									<strong>
										{report.position
											? `${report.position} ${t("report.of")} ${report.classSize}`
											: "—"}
									</strong>
								</span>
							</div>
						</>
					))}
			</CardContent>
		</Card>
	);
}
