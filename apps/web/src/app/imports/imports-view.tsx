"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UploadIcon, DownloadIcon, RefreshCwIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { getDict, type DictKey, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
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

const DOMAIN_OPTIONS: Array<{ key: string; labelKey: DictKey }> = [
	{ key: "students", labelKey: "imports.domain.students" },
	{ key: "opening_balances", labelKey: "imports.domain.opening_balances" },
];

interface FieldDef {
	key: string;
	label: string;
	required: boolean;
}

interface UploadResult {
	jobId: string;
	domain: string;
	rowCount: number;
	headers: string[];
	sampleRows: Record<string, string>[];
	suggestedMapping: Record<string, { field: string | null; confidence: string }>;
	savedMapping: Record<string, string | null> | null;
	fields: FieldDef[];
}

interface ValidationSummary {
	rowCount: number;
	valid: number;
	warnings: number;
	invalid: number;
	duplicates: number;
	issues: Array<{
		rowNumber: number;
		status: string;
		duplicate: string;
		errors: Array<{ field: string; code: string; message: string }>;
	}>;
}

interface JobRow {
	id: string;
	domain: string;
	status: string;
	original_filename: string;
	row_count: number;
	valid_rows: number;
	warning_rows: number;
	invalid_rows: number;
	committed_rows: number;
	failed_rows: number;
	created_at: string;
	committed_at: string | null;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
	committed: "default",
	failed: "destructive",
	cancelled: "outline",
};

export function ImportsView({ tenantId, lang }: { tenantId: string; lang: Lang }) {
	const t = getDict(lang);
	const [jobs, setJobs] = useState<JobRow[]>([]);
	const [domain, setDomain] = useState("students");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [upload, setUpload] = useState<UploadResult | null>(null);
	const [mapping, setMapping] = useState<Record<string, string | null>>({});
	const [summary, setSummary] = useState<ValidationSummary | null>(null);
	const [approved, setApproved] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	const reload = useCallback(async () => {
		const res = await apiFetch("/api/v1/imports", { tenantId });
		if (res.ok) {
			const body = (await res.json()) as { jobs: JobRow[] };
			setJobs(body.jobs);
		}
	}, [tenantId]);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reload();
	}, [reload]);

	// While a job is committing, poll history so progress is visible.
	useEffect(() => {
		if (!approved) return;
		const timer = setInterval(() => void reload(), 3000);
		return () => clearInterval(timer);
	}, [approved, reload]);

	async function handleUpload(file: File) {
		setPending(true);
		setError(null);
		setSummary(null);
		setApproved(false);
		try {
			const form = new FormData();
			form.append("file", file);
			form.append("domain", domain);
			const res = await apiFetch("/api/v1/imports", {
				method: "POST",
				body: form,
				tenantId,
			});
			const body = (await res.json().catch(() => null)) as UploadResult | { code?: string; message?: string } | null;
			if (!res.ok || !body || !("jobId" in body)) {
				setError(apiErrorMessage(t, body as { code?: string; message?: string } | null, res.status));
				return;
			}
			setUpload(body);
			// Saved mapping wins; otherwise apply high/medium-confidence guesses.
			const initial: Record<string, string | null> = {};
			for (const header of body.headers) {
				initial[header] =
					body.savedMapping?.[header] ??
					body.suggestedMapping[header]?.field ??
					null;
			}
			setMapping(initial);
		} finally {
			setPending(false);
			if (fileInput.current) fileInput.current.value = "";
		}
	}

	async function handleValidate() {
		if (!upload) return;
		setPending(true);
		setError(null);
		try {
			const res = await apiFetch(`/api/v1/imports/${upload.jobId}/mapping`, {
				method: "PUT",
				body: JSON.stringify({ mapping }),
				tenantId,
			});
			const body = (await res.json().catch(() => null)) as ValidationSummary | { code?: string; missing?: string[] } | null;
			if (!res.ok || !body || !("rowCount" in body)) {
				const miss = (body as { missing?: string[] } | null)?.missing;
				setError(
					miss?.length
						? `${t("imports.missingRequired")} ${miss.join(", ")}`
						: apiErrorMessage(t, body as { code?: string } | null, res.status),
				);
				return;
			}
			setSummary(body);
			void reload();
		} finally {
			setPending(false);
		}
	}

	async function handleApprove() {
		if (!upload) return;
		setPending(true);
		setError(null);
		try {
			const res = await apiFetch(`/api/v1/imports/${upload.jobId}/approve`, {
				method: "POST",
				tenantId,
			});
			const body = (await res.json().catch(() => null)) as { queued?: boolean; code?: string } | null;
			if (!res.ok || !body?.queued) {
				setError(apiErrorMessage(t, body, res.status));
				return;
			}
			setApproved(true);
			void reload();
		} finally {
			setPending(false);
		}
	}

	async function handleDownload(jobId: string, target: "original" | "errors") {
		setError(null);
		try {
			const res = await apiFetch(`/api/v1/imports/${jobId}/download?target=${target}`, { tenantId });
			const body = (await res.json().catch(() => null)) as { url?: string; code?: string } | null;
			if (res.ok && body?.url) {
				window.open(body.url, "_blank", "noopener");
			} else {
				setError(apiErrorMessage(t, body, res.status));
			}
		} catch {
			setError(t("common.apiUnreachable"));
		}
	}

	function resetWizard() {
		setUpload(null);
		setSummary(null);
		setApproved(false);
		setError(null);
	}

	return (
		<div className="flex flex-col gap-4 p-4 md:p-6">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">{t("nav.imports")}</h1>
				{upload && (
					<Button variant="outline" size="sm" onClick={resetWizard}>
						{t("imports.startOver")}
					</Button>
				)}
			</div>

			{error && (
				<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{error}
				</div>
			)}

			{/* Step 1 — upload */}
			{!upload && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">{t("imports.step1")}</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center">
						<select
							className="h-9 rounded-md border bg-transparent px-2 text-sm"
							value={domain}
							onChange={(e) => setDomain(e.target.value)}
						>
							{DOMAIN_OPTIONS.map((d) => (
								<option key={d.key} value={d.key}>
									{t(d.labelKey)}
								</option>
							))}
						</select>
						<input
							ref={fileInput}
							type="file"
							accept=".csv,.xlsx,.xls"
							className="text-sm"
							disabled={pending}
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) void handleUpload(file);
							}}
						/>
						{pending && <span className="text-sm text-muted-foreground">{t("common.loading")}</span>}
					</CardContent>
				</Card>
			)}

			{/* Step 2 — map columns */}
			{upload && !approved && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">
							{t("imports.step2")} — {upload.rowCount} {t("imports.rowsDetected")} “
							{jobs.find((j) => j.id === upload.jobId)?.original_filename ?? "…"}”
						</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("imports.uploadedColumn")}</TableHead>
									<TableHead>{t("imports.sample")}</TableHead>
									<TableHead>{t("imports.atlasField")}</TableHead>
									<TableHead>{t("imports.confidence")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{upload.headers.map((header) => {
									const suggestion = upload.suggestedMapping[header];
									return (
										<TableRow key={header}>
											<TableCell className="font-medium">{header}</TableCell>
											<TableCell className="max-w-40 truncate text-muted-foreground">
												{upload.sampleRows
													.map((r) => r[header])
													.filter(Boolean)
													.slice(0, 2)
													.join(", ")}
											</TableCell>
											<TableCell>
												<select
													className="h-8 rounded-md border bg-transparent px-2 text-sm"
													value={mapping[header] ?? ""}
													onChange={(e) =>
														setMapping((m) => ({ ...m, [header]: e.target.value || null }))
													}
												>
													<option value="">{t("imports.ignore")}</option>
													{upload.fields.map((f) => (
														<option key={f.key} value={f.key}>
															{f.label}
															{f.required ? " *" : ""}
														</option>
													))}
												</select>
											</TableCell>
											<TableCell>
												{suggestion?.field && (
													<Badge variant={suggestion.confidence === "high" ? "default" : "secondary"}>
														{suggestion.confidence}
													</Badge>
												)}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
						<div>
							<Button onClick={() => void handleValidate()} disabled={pending}>
								{pending ? t("common.loading") : t("imports.validate")}
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Step 3 — dry-run summary + approve */}
			{upload && summary && !approved && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">{t("imports.step3")}</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
							<Stat label={t("imports.rows")} value={summary.rowCount} />
							<Stat label={t("imports.valid")} value={summary.valid} />
							<Stat label={t("imports.warnings")} value={summary.warnings} />
							<Stat label={t("imports.invalid")} value={summary.invalid} />
							<Stat label={t("imports.duplicates")} value={summary.duplicates} />
						</div>
						{summary.issues.length > 0 && (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("students.row")}</TableHead>
										<TableHead>{t("students.status")}</TableHead>
										<TableHead>{t("imports.problems")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{summary.issues.map((issue) => (
										<TableRow key={issue.rowNumber}>
											<TableCell>{issue.rowNumber}</TableCell>
											<TableCell>
												<Badge variant={issue.status === "invalid" ? "destructive" : "secondary"}>
													{issue.status}
												</Badge>
											</TableCell>
											<TableCell className="text-sm text-muted-foreground">
												{issue.errors.map((e) => e.message).join("; ")}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
						<p className="text-sm text-muted-foreground">{t("imports.invalidSkipped")}</p>
						<div className="flex gap-2">
							<Button
								onClick={() => void handleApprove()}
								disabled={pending || summary.valid + summary.warnings === 0}
							>
								{pending
									? t("common.loading")
									: `${t("imports.approve")} ${summary.valid + summary.warnings} ${t("imports.rowsWord")}`}
							</Button>
						</div>
					</CardContent>
				</Card>
			)}

			{approved && (
				<Card>
					<CardContent className="flex items-center gap-3 py-4 text-sm">
						<RefreshCwIcon className="size-4 animate-spin" />
						{t("imports.queued")}
					</CardContent>
				</Card>
			)}

			{/* History */}
			<Card>
				<CardHeader>
					<CardTitle className="text-base">{t("imports.history")}</CardTitle>
				</CardHeader>
				<CardContent>
					{jobs.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">{t("imports.empty")}</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("imports.file")}</TableHead>
									<TableHead>{t("imports.type")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
									<TableHead className="text-right">{t("imports.rows")}</TableHead>
									<TableHead className="text-right">{t("imports.imported")}</TableHead>
									<TableHead className="text-right">{t("common.failed")}</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{jobs.map((job) => (
									<TableRow key={job.id}>
										<TableCell className="max-w-48 truncate font-medium">
											{job.original_filename}
										</TableCell>
										<TableCell>
											{t(
												job.domain === "students"
													? "imports.domain.students"
													: "imports.domain.opening_balances",
											)}
										</TableCell>
										<TableCell>
											<Badge variant={STATUS_VARIANT[job.status] ?? "secondary"}>{job.status}</Badge>
										</TableCell>
										<TableCell className="text-right">{job.row_count}</TableCell>
										<TableCell className="text-right">{job.committed_rows}</TableCell>
										<TableCell className="text-right">
											{job.failed_rows + job.invalid_rows}
										</TableCell>
										<TableCell className="flex justify-end gap-1">
											<Button
												aria-label={t("imports.downloadOriginal")}
												variant="ghost"
												size="icon"
												onClick={() => void handleDownload(job.id, "original")}
											>
												<UploadIcon className="size-4 rotate-180" />
											</Button>
											{(job.invalid_rows > 0 || job.failed_rows > 0) &&
												["committed", "failed"].includes(job.status) && (
													<Button
														aria-label={t("imports.downloadErrors")}
														variant="ghost"
														size="icon"
														onClick={() => void handleDownload(job.id, "errors")}
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

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="rounded-md border p-3">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="text-lg font-semibold">{value}</div>
		</div>
	);
}
