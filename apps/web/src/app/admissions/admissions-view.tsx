"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type Lang } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

export interface AdmissionRow {
	id: string;
	student_number: string;
	first_name: string;
	middle_name: string | null;
	last_name: string;
	status: string;
	admission_date: string;
	created_at: string;
	class_enrolments: Array<{
		class_sections: {
			name: string;
			grade_levels: { name: string; sequence: number } | null;
		} | null;
	}>;
}

// Keep in sync with the first-paint fetch in ./page.tsx.
const PAGE_SIZE = 50;

const ADMISSION_LIST_SELECT = `id, student_number, first_name, middle_name, last_name, status,
	 admission_date, created_at,
	 class_enrolments(class_sections(name, grade_levels(name, sequence)))`;

/** PostgREST `.or()` filters break on commas/parens/percent — strip them. */
function sanitizeSearch(value: string) {
	return value.replace(/[,()%\\]/g, " ").trim();
}

export function AdmissionsView({
	students,
	total,
	tenantId,
	lang,
}: {
	students: AdmissionRow[];
	total: number;
	tenantId: string;
	lang: Lang;
}) {
	const t = useMemo(() => getDict(lang), [lang]);
	const [rows, setRows] = useState<AdmissionRow[]>(students.slice(0, PAGE_SIZE));
	const [count, setCount] = useState(total);
	const [page, setPage] = useState(0);
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState(""); // debounced
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const firstRun = useRef(true);

	useEffect(() => {
		const handle = setTimeout(() => {
			setSearch(query);
			setPage(0);
		}, 300);
		return () => clearTimeout(handle);
	}, [query]);

	const reload = useCallback(async () => {
		setLoading(true);
		setLoadError(null);
		const supabase = createClient();
		let builder = supabase
			.from("students")
			.select(ADMISSION_LIST_SELECT, { count: "exact" })
			.eq("tenant_id", tenantId);
		const q = sanitizeSearch(search);
		if (q) {
			builder = builder.or(
				`first_name.ilike.%${q}%,middle_name.ilike.%${q}%,last_name.ilike.%${q}%,student_number.ilike.%${q}%`,
			);
		}
		const { data, count: exact, error } = await builder
			.order("created_at", { ascending: false })
			.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
		if (error) {
			setLoadError(t("err.server"));
		} else {
			setRows((data ?? []) as unknown as AdmissionRow[]);
			setCount(exact ?? 0);
		}
		setLoading(false);
	}, [tenantId, search, page, t]);

	useEffect(() => {
		// The server page provides the first page for first paint — only fetch
		// once search/pagination actually change.
		if (firstRun.current) {
			firstRun.current = false;
			return;
		}
		void reload();
	}, [reload]);

	const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));

	// Enrolment counts grouped by grade level, ordered by grade sequence, from
	// the server-provided snapshot (first 1000 newest); students without an
	// active enrolment fall into an "unassigned" bucket.
	const { gradeCounts, unassigned } = useMemo(() => {
		const byGrade = new Map<string, { sequence: number; count: number }>();
		let none = 0;
		for (const s of students) {
			const grade = s.class_enrolments[0]?.class_sections?.grade_levels;
			if (!grade) {
				none += 1;
				continue;
			}
			const entry = byGrade.get(grade.name) ?? { sequence: grade.sequence, count: 0 };
			entry.count += 1;
			byGrade.set(grade.name, entry);
		}
		return {
			gradeCounts: [...byGrade.entries()].sort((a, b) => a[1].sequence - b[1].sequence),
			unassigned: none,
		};
	}, [students]);

	return (
		<div className="flex flex-col gap-4">
			<h1 className="text-xl font-semibold">{t("admissions.title")}</h1>

			<div className="grid gap-4 md:grid-cols-2">
				<Card className="shadow-none">
					<CardHeader>
						<CardTitle className="text-sm font-medium text-muted-foreground">
							{t("admissions.totalEnrolled")}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<p className="font-mono text-3xl font-medium">{total}</p>
						<p className="mt-1 text-xs text-muted-foreground">{t("attendance.students")}</p>
					</CardContent>
				</Card>

				<Card className="shadow-none">
					<CardHeader>
						<CardTitle className="text-sm font-medium text-muted-foreground">
							{t("admissions.byGrade")}
						</CardTitle>
					</CardHeader>
					<CardContent>
						{gradeCounts.length === 0 && unassigned === 0 ? (
							<p className="py-4 text-center text-sm text-muted-foreground">
								{t("admissions.empty")}
							</p>
						) : (
							<div className="flex flex-col">
								{gradeCounts.map(([name, { count: n }]) => (
									<div
										className="flex items-center justify-between border-b border-border py-1.5 text-sm last:border-b-0"
										key={name}
									>
										<span>{name}</span>
										<span className="font-mono">{n}</span>
									</div>
								))}
								{unassigned > 0 && (
									<div className="flex items-center justify-between py-1.5 text-sm text-muted-foreground">
										<span>{t("admissions.unassigned")}</span>
										<span className="font-mono">{unassigned}</span>
									</div>
								)}
							</div>
						)}
					</CardContent>
				</Card>
			</div>

			<Card className="shadow-none">
				<CardHeader className="flex flex-row items-center justify-between gap-2">
					<CardTitle className="text-base">{t("admissions.recent")}</CardTitle>
					<div className="relative w-full max-w-xs">
						<SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							className="pl-9"
							onChange={(e) => setQuery(e.target.value)}
							placeholder={t("students.search")}
							type="search"
							value={query}
						/>
					</div>
				</CardHeader>
				<CardContent>
					{loadError && <p className="pb-2 text-sm text-destructive">{loadError}</p>}
					{loading ? (
						<ListSkeleton className="border-0 p-0" rows={8} />
					) : rows.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							{search ? t("students.noMatches") : t("admissions.empty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("admissions.admissionNo")}</TableHead>
									<TableHead>{t("students.name")}</TableHead>
									<TableHead>{t("students.class")}</TableHead>
									<TableHead>{t("admissions.admitted")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((s) => {
									const section = s.class_enrolments[0]?.class_sections;
									return (
										<TableRow key={s.id}>
											<TableCell className="font-mono text-xs">{s.student_number}</TableCell>
											<TableCell>
												{[s.first_name, s.middle_name, s.last_name].filter(Boolean).join(" ")}
											</TableCell>
											<TableCell>
												{section ? `${section.grade_levels?.name ?? ""} ${section.name}` : "—"}
											</TableCell>
											<TableCell className="font-mono text-xs text-muted-foreground">
												{s.admission_date}
											</TableCell>
											<TableCell>
												<Badge variant="outline">{s.status}</Badge>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					)}
					{totalPages > 1 && (
						<div className="flex items-center justify-end gap-2 pt-3">
							<Button
								disabled={page === 0 || loading}
								onClick={() => setPage((p) => Math.max(0, p - 1))}
								size="sm"
								variant="outline"
							>
								{t("common.prev")}
							</Button>
							<span className="font-mono text-sm text-muted-foreground">
								{page + 1} {t("report.of")} {totalPages}
							</span>
							<Button
								disabled={page >= totalPages - 1 || loading}
								onClick={() => setPage((p) => p + 1)}
								size="sm"
								variant="outline"
							>
								{t("common.next")}
							</Button>
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
