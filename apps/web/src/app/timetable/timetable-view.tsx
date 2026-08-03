"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarRangeIcon, Trash2Icon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type DictKey, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
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
	educationLevel: string;
}

export interface PeriodRow {
	id: string;
	label: string;
	startsAt: string;
	endsAt: string;
	isBreak: boolean;
}

export interface SubjectOption {
	id: string;
	code: string;
	name: string;
	nameSw: string | null;
	educationLevel: string;
}

interface Slot {
	id: string;
	sectionId: string;
	sectionLabel: string;
	day: number;
	periodId: string;
	subjectId: string;
	subjectCode: string;
	subjectName: string;
	subjectNameSw: string | null;
	teacherUserId: string;
	teacherName: string;
}

interface Teacher {
	userId: string;
	fullName: string;
}

const DAYS = [1, 2, 3, 4, 5] as const;

const DEFAULT_PERIODS = [
	{ label: "P1", startsAt: "08:00", endsAt: "08:40" },
	{ label: "P2", startsAt: "08:40", endsAt: "09:20" },
	{ label: "P3", startsAt: "09:20", endsAt: "10:00" },
	{ label: "Break", startsAt: "10:00", endsAt: "10:30", isBreak: true },
	{ label: "P4", startsAt: "10:30", endsAt: "11:10" },
	{ label: "P5", startsAt: "11:10", endsAt: "11:50" },
	{ label: "P6", startsAt: "11:50", endsAt: "12:30" },
	{ label: "Lunch", startsAt: "12:30", endsAt: "13:30", isBreak: true },
	{ label: "P7", startsAt: "13:30", endsAt: "14:10" },
	{ label: "P8", startsAt: "14:10", endsAt: "14:50" },
];

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TimetableView({
	tenantId,
	sections,
	sectionId,
	teacherMode,
	periods,
	subjects,
	canManage,
	lang,
}: {
	tenantId: string;
	sections: SectionOption[];
	sectionId: string | null;
	teacherMode: boolean;
	periods: PeriodRow[];
	subjects: SubjectOption[];
	canManage: boolean;
	lang: Lang;
}) {
	const t = useMemo(() => getDict(lang), [lang]);
	const router = useRouter();
	const [slots, setSlots] = useState<Slot[]>([]);
	const [teachers, setTeachers] = useState<Teacher[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [editing, setEditing] = useState<{ day: number; periodId: string } | null>(null);

	const section = sections.find((s) => s.id === sectionId) ?? null;
	const sectionSubjects = section
		? subjects.filter((s) => s.educationLevel === section.educationLevel)
		: [];

	const reload = useCallback(async () => {
		if (!teacherMode && !sectionId) {
			setLoaded(true);
			return;
		}
		setLoaded(false);
		setLoadError(null);
		try {
			const response = await apiFetch(
				`/api/v1/timetable?${teacherMode ? "teacherUserId=me" : `sectionId=${sectionId}`}`,
				{ tenantId },
			);
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setLoadError(apiErrorMessage(t, body, response.status));
				return;
			}
			setSlots((await response.json()).data);
		} catch {
			setLoadError(t("common.apiUnreachable"));
		} finally {
			setLoaded(true);
		}
	}, [tenantId, sectionId, teacherMode, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reload();
	}, [reload]);

	useEffect(() => {
		if (!canManage) return;
		void (async () => {
			const response = await apiFetch("/api/v1/timetable/teachers", { tenantId });
			if (response.ok) setTeachers((await response.json()).data);
		})();
	}, [canManage, tenantId]);

	function navigate(nextSection: string | null, nextTeacherMode: boolean) {
		const query = new URLSearchParams();
		if (nextSection) query.set("section", nextSection);
		if (nextTeacherMode) query.set("teacher", "me");
		router.push(`/timetable?${query.toString()}`);
	}

	async function createDefaultPeriods() {
		setPending(true);
		setLoadError(null);
		try {
			const response = await apiFetch("/api/v1/timetable/periods", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ periods: DEFAULT_PERIODS }),
			});
			if (response.ok) {
				router.refresh();
			} else {
				const body = await response.json().catch(() => null);
				setLoadError(apiErrorMessage(t, body, response.status));
			}
		} catch {
			setLoadError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	const slotFor = (day: number, periodId: string) =>
		slots.find((s) => s.day === day && s.periodId === periodId) ?? null;

	const editingSlot = editing ? slotFor(editing.day, editing.periodId) : null;
	const editingPeriod = editing ? (periods.find((p) => p.id === editing.periodId) ?? null) : null;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("timetable.title")}</h1>
				<div className="flex flex-wrap items-center gap-2">
					{!teacherMode && (
						<select
							aria-label={t("timetable.selectClass")}
							className={selectClass}
							onChange={(e) => navigate(e.target.value || null, false)}
							value={sectionId ?? ""}
						>
							<option value="">{t("timetable.selectClass")}</option>
							{sections.map((s) => (
								<option key={s.id} value={s.id}>
									{s.label}
								</option>
							))}
						</select>
					)}
					<Button
						onClick={() => navigate(teacherMode ? null : sectionId, !teacherMode)}
						size="sm"
						variant={teacherMode ? "default" : "outline"}
					>
						<CalendarRangeIcon /> {t("timetable.myTimetable")}
					</Button>
				</div>
			</div>

			{loadError && (
				<div className="flex items-center gap-3" role="alert">
					<p className="text-sm text-destructive">{loadError}</p>
					<Button onClick={() => void reload()} size="sm" variant="outline">
						{t("common.retry")}
					</Button>
				</div>
			)}

			{periods.length === 0 ? (
				<Card className="shadow-none">
					<CardContent className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
						{t("timetable.noPeriods")}
						{canManage && (
							<Button disabled={pending} onClick={() => void createDefaultPeriods()} size="sm">
								{pending ? t("common.loading") : t("timetable.createDefaults")}
							</Button>
						)}
					</CardContent>
				</Card>
			) : !teacherMode && !sectionId ? (
				<Card className="shadow-none">
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						{t("timetable.pickPrompt")}
					</CardContent>
				</Card>
			) : !loaded && !loadError ? (
				<ListSkeleton rows={8} />
			) : (
				<Card className="shadow-none">
					<CardContent className="overflow-x-auto pt-4">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("timetable.period")}</TableHead>
									{DAYS.map((d) => (
										<TableHead key={d}>{t(`timetable.day.${d}` as DictKey)}</TableHead>
									))}
								</TableRow>
							</TableHeader>
							<TableBody>
								{periods.map((p) => (
									<TableRow key={p.id}>
										<TableCell className="whitespace-nowrap">
											<div className="text-sm font-medium">
												{p.isBreak ? t("timetable.break") : p.label}
											</div>
											<div className="font-mono text-xs text-muted-foreground">
												{p.startsAt}–{p.endsAt}
											</div>
										</TableCell>
										{p.isBreak ? (
											<TableCell
												className="bg-muted text-center text-xs text-muted-foreground"
												colSpan={DAYS.length}
											>
												{t("timetable.break")}
											</TableCell>
										) : (
											DAYS.map((d) => {
												const slot = slotFor(d, p.id);
												const cell = slot ? (
													<div>
														<div className="text-sm font-medium">{slot.subjectCode}</div>
														<div className="text-xs text-muted-foreground">
															{teacherMode ? slot.sectionLabel : slot.teacherName}
														</div>
													</div>
												) : (
													<span className="text-xs text-muted-foreground">—</span>
												);
												return (
													<TableCell key={d}>
														{canManage && !teacherMode ? (
															<button
																className="w-full rounded-md px-1 py-1 text-left transition-colors hover:bg-muted"
																onClick={() => setEditing({ day: d, periodId: p.id })}
																type="button"
															>
																{cell}
															</button>
														) : (
															cell
														)}
													</TableCell>
												);
											})
										)}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			{canManage && !teacherMode && sectionId && (
				<SlotDialog
					day={editing?.day ?? 1}
					key={editing ? `${editing.day}:${editing.periodId}:${editingSlot?.id ?? "new"}` : "closed"}
					lang={lang}
					onClose={() => setEditing(null)}
					onSaved={async () => {
						setEditing(null);
						await reload();
					}}
					open={editing !== null}
					period={editingPeriod}
					sectionId={sectionId}
					slot={editingSlot}
					subjects={sectionSubjects}
					teachers={teachers}
					tenantId={tenantId}
				/>
			)}
		</div>
	);
}

function SlotDialog({
	tenantId,
	sectionId,
	day,
	period,
	slot,
	subjects,
	teachers,
	open,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	sectionId: string;
	day: number;
	period: PeriodRow | null;
	slot: Slot | null;
	subjects: SubjectOption[];
	teachers: Teacher[];
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [subjectId, setSubjectId] = useState(slot?.subjectId ?? "");
	const [teacherUserId, setTeacherUserId] = useState(slot?.teacherUserId ?? "");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		if (!period || !subjectId || !teacherUserId) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/timetable/slots", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ sectionId, day, periodId: period.id, subjectId, teacherUserId }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(
					body?.code === "TIMETABLE_TEACHER_CLASH"
						? t("timetable.clash")
						: apiErrorMessage(t, body, response.status),
				);
				return;
			}
			await onSaved();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	async function remove() {
		if (!slot) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/timetable/slots/${slot.id}`, {
				method: "DELETE",
				tenantId,
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
					<DialogTitle>
						{t("timetable.editLesson")}
						{period &&
							` — ${t(`timetable.day.${day}` as DictKey)} ${period.label} (${period.startsAt}–${period.endsAt})`}
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("timetable.subject")}
						<select
							className={selectClass}
							onChange={(e) => setSubjectId(e.target.value)}
							value={subjectId}
						>
							<option value="">{t("timetable.selectSubject")}</option>
							{subjects.map((s) => (
								<option key={s.id} value={s.id}>
									{s.code} — {lang === "sw" && s.nameSw ? s.nameSw : s.name}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("timetable.teacher")}
						<select
							className={selectClass}
							onChange={(e) => setTeacherUserId(e.target.value)}
							value={teacherUserId}
						>
							<option value="">{t("timetable.selectTeacher")}</option>
							{teachers.map((m) => (
								<option key={m.userId} value={m.userId}>
									{m.fullName}
								</option>
							))}
						</select>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex items-center justify-between">
						{slot ? (
							<Button
								disabled={pending}
								onClick={() => void remove()}
								size="sm"
								variant="outline"
							>
								<Trash2Icon /> {t("timetable.remove")}
							</Button>
						) : (
							<span />
						)}
						<Button
							disabled={pending || !subjectId || !teacherUserId}
							onClick={() => void save()}
						>
							{pending ? t("common.loading") : t("timetable.save")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
