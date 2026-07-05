"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon } from "lucide-react";
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

export interface SectionOption {
	id: string;
	label: string;
}

export interface RosterRow {
	id: string;
	student_number: string;
	first_name: string;
	middle_name: string | null;
	last_name: string;
}

export interface ExistingSession {
	revision: number;
	records: Record<string, string>;
}

type Status = "present" | "absent" | "late" | "excused";
const STATUSES: Status[] = ["present", "absent", "late", "excused"];

const STATUS_STYLES: Record<Status, string> = {
	present: "bg-primary text-primary-foreground border-primary",
	absent: "bg-destructive text-white border-destructive",
	late: "bg-amber-500 text-white border-amber-500",
	excused: "bg-muted text-muted-foreground border-input",
};

export function AttendanceView({
	tenantId,
	sections,
	sectionId,
	date,
	roster,
	existing,
	lang,
}: {
	tenantId: string;
	sections: SectionOption[];
	sectionId: string | null;
	date: string;
	roster: RosterRow[];
	existing: ExistingSession | null;
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState<{ alertsQueued: number } | null>(null);
	const [statuses, setStatuses] = useState<Record<string, Status>>(() => {
		const initial: Record<string, Status> = {};
		for (const s of roster) {
			const prev = existing?.records[s.id];
			initial[s.id] = STATUSES.includes(prev as Status) ? (prev as Status) : "present";
		}
		return initial;
	});

	function navigate(nextSection: string | null, nextDate: string) {
		const query = new URLSearchParams();
		if (nextSection) query.set("section", nextSection);
		query.set("date", nextDate);
		router.push(`/attendance?${query.toString()}`);
	}

	async function save() {
		if (!sectionId) return;
		setPending(true);
		setError(null);
		setSaved(null);
		const response = await apiFetch("/api/v1/attendance", {
			method: "POST",
			tenantId,
			body: JSON.stringify({
				classSectionId: sectionId,
				date,
				records: roster.map((s) => ({ studentId: s.id, status: statuses[s.id] })),
			}),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		const body = await response.json();
		setSaved({ alertsQueued: body.alertsQueued ?? 0 });
		router.refresh();
	}

	const counts = STATUSES.map((status) => ({
		status,
		n: roster.filter((s) => statuses[s.id] === status).length,
	})).filter((c) => c.n > 0);

	const selectClass =
		"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("attendance.title")}</h1>
				<div className="flex flex-wrap items-center gap-2">
					<select
						className={selectClass}
						onChange={(e) => navigate(e.target.value || null, date)}
						value={sectionId ?? ""}
					>
						<option value="">{t("attendance.selectClass")}</option>
						{sections.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
					<Input
						aria-label={t("attendance.date")}
						className="w-auto"
						onChange={(e) => navigate(sectionId, e.target.value)}
						type="date"
						value={date}
					/>
				</div>
			</div>

			{!sectionId ? (
				<Card className="shadow-none">
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						{t("attendance.pickPrompt")}
					</CardContent>
				</Card>
			) : roster.length === 0 ? (
				<Card className="shadow-none">
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						{t("attendance.empty")}
					</CardContent>
				</Card>
			) : (
				<Card className="shadow-none">
					<CardContent className="flex flex-col gap-3 pt-4">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
								<span>
									{roster.length} {t("attendance.students")}
								</span>
								{counts.map((c) => (
									<Badge key={c.status} variant="outline">
										{t(`attendance.${c.status}` as Parameters<typeof t>[0])}: {c.n}
									</Badge>
								))}
							</div>
							<Button
								onClick={() =>
									setStatuses(Object.fromEntries(roster.map((s) => [s.id, "present"])))
								}
								size="sm"
								variant="outline"
							>
								<CheckIcon /> {t("attendance.markAllPresent")}
							</Button>
						</div>

						{existing && (
							<p className="text-sm text-amber-600">{t("attendance.correctionWarning")}</p>
						)}

						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("students.number")}</TableHead>
									<TableHead>{t("students.name")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
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
											<div className="flex gap-1">
												{STATUSES.map((status) => (
													<button
														className={`rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
															statuses[s.id] === status
																? STATUS_STYLES[status]
																: "border-input bg-transparent text-muted-foreground hover:bg-muted"
														}`}
														key={status}
														onClick={() =>
															setStatuses((prev) => ({ ...prev, [s.id]: status }))
														}
														type="button"
													>
														{t(`attendance.${status}` as Parameters<typeof t>[0])}
													</button>
												))}
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>

						{error && <p className="text-sm text-destructive">{error}</p>}
						{saved && (
							<p className="text-sm font-medium text-primary">
								{t("attendance.saved")}
								{saved.alertsQueued > 0 && ` ${saved.alertsQueued} ${t("attendance.alertsQueued")}.`}
							</p>
						)}
						<div className="flex justify-end">
							<Button disabled={pending} onClick={() => void save()}>
								{pending ? t("common.loading") : t("attendance.save")}
							</Button>
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
