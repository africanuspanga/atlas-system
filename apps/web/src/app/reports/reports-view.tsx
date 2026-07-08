"use client";

import { useCallback, useEffect, useState } from "react";
import { DownloadIcon, FileTextIcon, RefreshCwIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

interface CatalogueEntry {
	key: string;
	title: string;
	formats: string[];
}

interface ReportJob {
	id: string;
	report_key: string;
	format: string;
	status: string;
	reference: string;
	error: string | null;
	created_at: string;
	completed_at: string | null;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
	completed: "default",
	failed: "destructive",
	cancelled: "outline",
	expired: "outline",
};

function firstOfMonth(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

export function ReportsView({
	tenantId,
	lang,
	students,
	terms,
}: {
	tenantId: string;
	lang: Lang;
	students: Array<{ id: string; label: string }>;
	terms: Array<{ id: string; name: string }>;
}) {
	const t = getDict(lang);
	const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
	const [jobs, setJobs] = useState<ReportJob[]>([]);
	const [reportKey, setReportKey] = useState("fee_collection");
	const [format, setFormat] = useState("csv");
	const [from, setFrom] = useState(firstOfMonth());
	const [to, setTo] = useState(today());
	const [studentId, setStudentId] = useState("");
	const [termId, setTermId] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [forbidden, setForbidden] = useState(false);

	const reload = useCallback(async () => {
		const res = await apiFetch("/api/v1/reports", { tenantId });
		if (res.ok) setJobs(((await res.json()) as { jobs: ReportJob[] }).jobs);
	}, [tenantId]);

	useEffect(() => {
		void (async () => {
			const res = await apiFetch("/api/v1/reports/catalogue", { tenantId });
			if (res.status === 403) {
				setForbidden(true);
				return;
			}
			if (res.ok) {
				const body = (await res.json()) as { reports: CatalogueEntry[] };
				setCatalogue(body.reports);
				if (body.reports.length > 0) {
					setReportKey(body.reports[0].key);
					setFormat(body.reports[0].formats[0]);
				}
			}
			void reload();
		})();
	}, [tenantId, reload]);

	// Poll while any job is still running.
	useEffect(() => {
		if (!jobs.some((j) => ["queued", "processing"].includes(j.status))) return;
		const timer = setInterval(() => void reload(), 3000);
		return () => clearInterval(timer);
	}, [jobs, reload]);

	const selected = catalogue.find((c) => c.key === reportKey);
	const needsDates = reportKey === "fee_collection";
	const needsStudent = ["student_statement", "report_card"].includes(reportKey);
	const needsTerm = reportKey === "report_card";

	async function handleGenerate() {
		setPending(true);
		setError(null);
		try {
			const params: Record<string, string> = {};
			if (needsDates) {
				params.from = from;
				params.to = to;
			}
			if (needsStudent) params.studentId = studentId;
			if (needsTerm) params.termId = termId;
			const res = await apiFetch("/api/v1/reports", {
				method: "POST",
				body: JSON.stringify({ reportKey, format, params }),
				tenantId,
			});
			const body = (await res.json().catch(() => null)) as { jobId?: string; code?: string } | null;
			if (!res.ok || !body?.jobId) {
				setError(body?.code ?? `HTTP ${res.status}`);
				return;
			}
			void reload();
		} finally {
			setPending(false);
		}
	}

	async function handleDownload(jobId: string) {
		const res = await apiFetch(`/api/v1/reports/${jobId}/download`, { tenantId });
		const body = (await res.json().catch(() => null)) as { url?: string } | null;
		if (res.ok && body?.url) window.open(body.url, "_blank", "noopener");
	}

	if (forbidden) {
		return (
			<div className="p-6 text-sm text-muted-foreground">
				You do not have permission to generate reports. Ask your school administrator for the
				“reports.generate” role capability.
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-4 md:p-6">
			<h1 className="text-xl font-semibold">{t("nav.reports")}</h1>

			{error && (
				<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{error}
				</div>
			)}

			<Card>
				<CardHeader>
					<CardTitle className="flex items-center gap-2 text-base">
						<FileTextIcon className="size-4" /> Generate a report
					</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-wrap items-end gap-3">
					<label className="flex flex-col gap-1 text-sm">
						Report
						<select
							className="h-9 min-w-52 rounded-md border bg-transparent px-2 text-sm"
							value={reportKey}
							onChange={(e) => {
								setReportKey(e.target.value);
								const entry = catalogue.find((c) => c.key === e.target.value);
								if (entry && !entry.formats.includes(format)) setFormat(entry.formats[0]);
							}}
						>
							{catalogue.map((c) => (
								<option key={c.key} value={c.key}>
									{c.title}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						Format
						<select
							className="h-9 rounded-md border bg-transparent px-2 text-sm uppercase"
							value={format}
							onChange={(e) => setFormat(e.target.value)}
						>
							{(selected?.formats ?? ["csv"]).map((f) => (
								<option key={f} value={f}>
									{f.toUpperCase()}
								</option>
							))}
						</select>
					</label>
					{needsDates && (
						<>
							<label className="flex flex-col gap-1 text-sm">
								From
								<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-9" />
							</label>
							<label className="flex flex-col gap-1 text-sm">
								To
								<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-9" />
							</label>
						</>
					)}
					{needsStudent && (
						<label className="flex flex-col gap-1 text-sm">
							Student
							<select
								className="h-9 min-w-56 rounded-md border bg-transparent px-2 text-sm"
								value={studentId}
								onChange={(e) => setStudentId(e.target.value)}
							>
								<option value="">— select —</option>
								{students.map((s) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
						</label>
					)}
					{needsTerm && (
						<label className="flex flex-col gap-1 text-sm">
							Term
							<select
								className="h-9 min-w-40 rounded-md border bg-transparent px-2 text-sm"
								value={termId}
								onChange={(e) => setTermId(e.target.value)}
							>
								<option value="">— select —</option>
								{terms.map((tm) => (
									<option key={tm.id} value={tm.id}>
										{tm.name}
									</option>
								))}
							</select>
						</label>
					)}
					<Button
						onClick={() => void handleGenerate()}
						disabled={pending || (needsStudent && !studentId) || (needsTerm && !termId)}
					>
						{pending ? t("common.loading") : "Generate"}
					</Button>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Recent reports</CardTitle>
				</CardHeader>
				<CardContent>
					{jobs.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							No reports yet. Generate one above — it lands here with a download link.
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Reference</TableHead>
									<TableHead>Report</TableHead>
									<TableHead>Format</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Requested</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{jobs.map((job) => (
									<TableRow key={job.id}>
										<TableCell className="font-mono text-xs">{job.reference}</TableCell>
										<TableCell>{job.report_key.replaceAll("_", " ")}</TableCell>
										<TableCell className="uppercase">{job.format}</TableCell>
										<TableCell>
											<Badge variant={STATUS_VARIANT[job.status] ?? "secondary"}>
												{["queued", "processing"].includes(job.status) && (
													<RefreshCwIcon className="mr-1 size-3 animate-spin" />
												)}
												{job.status}
											</Badge>
											{job.error && (
												<span className="ml-2 text-xs text-destructive">{job.error}</span>
											)}
										</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{new Date(job.created_at).toLocaleString()}
										</TableCell>
										<TableCell className="text-right">
											{job.status === "completed" && (
												<Button
													aria-label="Download report"
													variant="ghost"
													size="icon"
													onClick={() => void handleDownload(job.id)}
												>
													<DownloadIcon className="size-4" />
												</Button>
											)}
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
