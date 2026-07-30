"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type Lang } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export interface GuardianRow {
	id: string;
	full_name: string;
	phone: string | null;
	email: string | null;
	occupation: string | null;
	user_id: string | null;
	student_guardians: Array<{
		relationship: string;
		is_primary: boolean;
		students: {
			id: string;
			first_name: string;
			middle_name: string | null;
			last_name: string;
			student_number: string;
		} | null;
	}>;
}

// Keep in sync with the first-paint fetch in ./page.tsx.
const PAGE_SIZE = 50;

const GUARDIAN_LIST_SELECT = `id, full_name, phone, email, occupation, user_id,
	 student_guardians(relationship, is_primary,
		 students(id, first_name, middle_name, last_name, student_number))`;

/** PostgREST `.or()` filters break on commas/parens/percent — strip them. */
function sanitizeSearch(value: string) {
	return value.replace(/[,()%\\]/g, " ").trim();
}

function studentLabel(s: NonNullable<GuardianRow["student_guardians"][number]["students"]>) {
	return [s.first_name, s.middle_name, s.last_name].filter(Boolean).join(" ");
}

export function ParentsView({
	guardians,
	total,
	tenantId,
	lang,
}: {
	guardians: GuardianRow[];
	total: number;
	tenantId: string;
	lang: Lang;
}) {
	const t = useMemo(() => getDict(lang), [lang]);
	const [rows, setRows] = useState<GuardianRow[]>(guardians);
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
			.from("guardians")
			.select(GUARDIAN_LIST_SELECT, { count: "exact" })
			.eq("tenant_id", tenantId);
		const q = sanitizeSearch(search);
		if (q) {
			builder = builder.or(
				`full_name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%`,
			);
		}
		const { data, count: exact, error } = await builder
			.order("full_name")
			.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
		if (error) {
			setLoadError(t("err.server"));
		} else {
			setRows((data ?? []) as unknown as GuardianRow[]);
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

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("parents.title")}</h1>
				<p className="text-sm text-muted-foreground">
					<span className="font-mono">{count}</span> {t("parents.total")}
				</p>
			</div>

			<div className="relative max-w-sm">
				<SearchIcon className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					className="pl-9"
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t("parents.searchPlaceholder")}
					type="search"
					value={query}
				/>
			</div>

			{loadError && <p className="text-sm text-destructive">{loadError}</p>}

			{loading ? (
				<ListSkeleton rows={8} />
			) : (
				<Card className="shadow-none">
					<CardContent className="pt-4">
						{rows.length === 0 ? (
							<p className="py-10 text-center text-sm text-muted-foreground">
								{search ? t("parents.noMatches") : t("parents.empty")}
							</p>
						) : (
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t("students.name")}</TableHead>
										<TableHead>{t("parents.phone")}</TableHead>
										<TableHead>{t("staff.email")}</TableHead>
										<TableHead>{t("parents.children")}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{rows.map((g) => (
										<TableRow key={g.id}>
											<TableCell>
												<span className="flex items-center gap-2">
													{g.full_name}
													{g.user_id && <Badge variant="outline">{t("parents.portal")}</Badge>}
												</span>
											</TableCell>
											<TableCell className="font-mono text-xs">{g.phone ?? "—"}</TableCell>
											<TableCell className="text-muted-foreground">{g.email ?? "—"}</TableCell>
											<TableCell>
												{g.student_guardians.length === 0 ? (
													"—"
												) : (
													<span className="flex flex-col gap-0.5">
														{g.student_guardians.map(
															(sg) =>
																sg.students && (
																	<span className="text-sm" key={sg.students.id}>
																		{studentLabel(sg.students)}{" "}
																		<span className="font-mono text-xs text-muted-foreground">
																			{sg.students.student_number}
																		</span>
																	</span>
																),
														)}
													</span>
												)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						)}
					</CardContent>
				</Card>
			)}

			{totalPages > 1 && (
				<div className="flex items-center justify-end gap-2">
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
		</div>
	);
}
