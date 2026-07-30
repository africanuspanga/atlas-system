"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HeartPulseIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type Lang } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export interface StudentOption {
	id: string;
	studentNumber: string;
	name: string;
}

interface VisitRow {
	id: string;
	visitedAt: string;
	studentNumber: string;
	studentName: string;
	symptoms: string;
	treatment: string | null;
	notes: string | null;
	notifyGuardian: boolean;
}

// Day label in Africa/Dar_es_Salaam (UTC+3, no DST) so a late-evening visit
// isn't bumped to the next/previous UTC day.
function visitDay(visitedAt: string): string {
	return new Date(new Date(visitedAt).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function ClinicView({
	tenantId,
	students,
	canManage,
	lang,
}: {
	tenantId: string;
	students: StudentOption[];
	canManage: boolean;
	lang: Lang;
}) {
	const t = useMemo(() => getDict(lang), [lang]);
	const [visits, setVisits] = useState<VisitRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [recordOpen, setRecordOpen] = useState(false);

	const reload = useCallback(async () => {
		const params = new URLSearchParams();
		if (from !== "") params.set("from", from);
		if (to !== "") params.set("to", to);
		const suffix = params.size > 0 ? `?${params.toString()}` : "";
		const response = await apiFetch(`/api/v1/clinic/visits${suffix}`, { tenantId });
		if (!response.ok) {
			setLoadError(`${t("clinic.loadFailed")} (HTTP ${response.status})`);
			setLoaded(true);
			return;
		}
		setLoadError(null);
		setVisits((await response.json()).data);
		setLoaded(true);
	}, [tenantId, from, to, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reload();
	}, [reload]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("clinic.title")}</h1>
				{canManage && (
					<Button onClick={() => setRecordOpen(true)} size="sm">
						<HeartPulseIcon /> {t("clinic.recordVisit")}
					</Button>
				)}
			</div>

			<div className="flex flex-wrap items-end gap-3">
				<label className="flex flex-col gap-1 text-sm">
					{t("clinic.from")}
					<Input
						className="w-40"
						onChange={(e) => setFrom(e.target.value)}
						type="date"
						value={from}
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					{t("clinic.to")}
					<Input
						className="w-40"
						onChange={(e) => setTo(e.target.value)}
						type="date"
						value={to}
					/>
				</label>
			</div>

			{loadError && <p className="text-sm text-destructive">{loadError}</p>}

			{!loaded && !loadError ? (
				<ListSkeleton rows={6} />
			) : loaded && !loadError && visits.length === 0 ? (
				<Card className="shadow-none">
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						{t("clinic.empty")}
					</CardContent>
				</Card>
			) : (
				<Card className="shadow-none">
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("clinic.date")}</TableHead>
									<TableHead>{t("clinic.student")}</TableHead>
									<TableHead>{t("clinic.symptoms")}</TableHead>
									<TableHead>{t("clinic.treatment")}</TableHead>
									<TableHead>{t("clinic.notified")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{visits.map((visit) => (
									<TableRow key={visit.id}>
										<TableCell className="font-mono">{visitDay(visit.visitedAt)}</TableCell>
										<TableCell>
											<span className="font-medium">{visit.studentName}</span>{" "}
											<span className="font-mono text-xs text-muted-foreground">
												{visit.studentNumber}
											</span>
										</TableCell>
										<TableCell className="max-w-56 truncate" title={visit.symptoms}>
											{visit.symptoms}
										</TableCell>
										<TableCell
											className="max-w-56 truncate text-muted-foreground"
											title={visit.treatment ?? undefined}
										>
											{visit.treatment ?? "—"}
										</TableCell>
										<TableCell>
											{visit.notifyGuardian && (
												<Badge variant="outline">{t("clinic.notified")}</Badge>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			{canManage && (
				<RecordVisitDialog
					key={recordOpen ? "open" : "closed"}
					lang={lang}
					onClose={() => setRecordOpen(false)}
					onSaved={async () => {
						setRecordOpen(false);
						await reload();
					}}
					open={recordOpen}
					students={students}
					tenantId={tenantId}
				/>
			)}
		</div>
	);
}

function RecordVisitDialog({
	tenantId,
	students,
	open,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	students: StudentOption[];
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [query, setQuery] = useState("");
	const [studentId, setStudentId] = useState("");
	const [symptoms, setSymptoms] = useState("");
	const [treatment, setTreatment] = useState("");
	const [notes, setNotes] = useState("");
	const [notify, setNotify] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const q = query.toLowerCase().trim();
	const matches =
		q === ""
			? students.slice(0, 8)
			: students
					.filter(
						(s) =>
							s.name.toLowerCase().includes(q) ||
							s.studentNumber.toLowerCase().includes(q),
					)
					.slice(0, 8);
	const selected = students.find((s) => s.id === studentId) ?? null;

	async function save() {
		if (!studentId || symptoms.trim().length < 2) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/clinic/visits", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					studentId,
					symptoms: symptoms.trim(),
					treatment: treatment.trim() === "" ? undefined : treatment.trim(),
					notes: notes.trim() === "" ? undefined : notes.trim(),
					notifyGuardian: notify,
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			await onSaved();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("clinic.recordVisit")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("clinic.student")}
						<Input
							onChange={(e) => {
								setQuery(e.target.value);
								setStudentId("");
							}}
							placeholder={t("clinic.searchStudent")}
							value={selected ? `${selected.name} (${selected.studentNumber})` : query}
						/>
					</label>
					{!selected && (
						<div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
							{matches.map((s) => (
								<button
									className="rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted"
									key={s.id}
									onClick={() => setStudentId(s.id)}
									type="button"
								>
									{s.name}{" "}
									<span className="font-mono text-xs text-muted-foreground">
										{s.studentNumber}
									</span>
								</button>
							))}
							{matches.length === 0 && (
								<p className="px-2 text-sm text-muted-foreground">{t("clinic.noMatches")}</p>
							)}
						</div>
					)}
					<label className="flex flex-col gap-1 text-sm">
						{t("clinic.symptoms")}
						<Input onChange={(e) => setSymptoms(e.target.value)} value={symptoms} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("clinic.treatmentOptional")}
						<Input onChange={(e) => setTreatment(e.target.value)} value={treatment} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("clinic.notes")}
						<Input onChange={(e) => setNotes(e.target.value)} value={notes} />
					</label>
					<label className="flex items-start gap-2 text-sm">
						<input
							checked={notify}
							className="mt-0.5 size-4 accent-primary"
							onChange={(e) => setNotify(e.target.checked)}
							type="checkbox"
						/>
						<span className="flex flex-col">
							{t("clinic.notifyGuardian")}
							<span className="text-xs text-muted-foreground">{t("clinic.notifyHint")}</span>
						</span>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button
							disabled={pending || !studentId || symptoms.trim().length < 2}
							onClick={() => void save()}
						>
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
