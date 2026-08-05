"use client";

import { useCallback, useEffect, useState } from "react";
import { BusIcon, PlusIcon, UsersIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface StudentOption {
	id: string;
	studentNumber: string;
	name: string;
}

interface StopRow {
	id: string;
	name: string;
	sortOrder: number;
}

interface RouteRow {
	id: string;
	name: string;
	feeAmount: number;
	students: number;
	stops: StopRow[];
}

interface RosterRow {
	assignmentId: string;
	studentNumber: string;
	name: string;
	stop: string | null;
}

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

const formatTZS = (amount: number) =>
	`TZS ${new Intl.NumberFormat("en-US").format(amount)}`;

export function TransportView({
	tenantId,
	students,
	academicYear,
	canManage,
}: {
	tenantId: string;
	students: StudentOption[];
	academicYear: { id: string; name: string } | null;
	canManage: boolean;
}) {
	const t = getDict();
	const [routes, setRoutes] = useState<RouteRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [stopRoute, setStopRoute] = useState<RouteRow | null>(null);
	const [assignOpen, setAssignOpen] = useState(false);
	const [rosterRoute, setRosterRoute] = useState<RouteRow | null>(null);

	const reload = useCallback(async () => {
		setLoaded(false);
		setLoadError(null);
		try {
			const response = await apiFetch("/api/v1/transport", { tenantId });
			if (!response.ok) {
				setLoadError(`${t("transport.loadFailed")} (HTTP ${response.status})`);
				return;
			}
			setRoutes((await response.json()).data);
		} catch {
			setLoadError(t("common.apiUnreachable"));
		} finally {
			setLoaded(true);
		}
	}, [tenantId, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reload();
	}, [reload]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("transport.title")}</h1>
				{canManage && (
					<div className="flex flex-wrap items-center gap-2">
						<Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
							<PlusIcon /> {t("transport.addRoute")}
						</Button>
						<Button disabled={routes.length === 0} onClick={() => setAssignOpen(true)} size="sm">
							<BusIcon /> {t("transport.assign")}
						</Button>
					</div>
				)}
			</div>

			{loadError && (
				<div className="flex items-center gap-3" role="alert">
					<p className="text-sm text-destructive">{loadError}</p>
					<Button onClick={() => void reload()} size="sm" variant="outline">
						{t("common.retry")}
					</Button>
				</div>
			)}
			{canManage && !academicYear && (
				<p className="text-sm text-muted-foreground">{t("transport.noYear")}</p>
			)}

			{!loaded && !loadError ? (
				<ListSkeleton rows={6} />
			) : loaded && !loadError && routes.length === 0 ? (
				<Card className="shadow-none">
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						{t("transport.empty")}
					</CardContent>
				</Card>
			) : (
				<div className="grid gap-4 lg:grid-cols-2">
					{routes.map((route) => (
						<Card className="shadow-none" key={route.id}>
							<CardHeader className="flex flex-row items-center justify-between gap-2">
								<div className="flex items-center gap-2">
									<CardTitle className="text-base">{route.name}</CardTitle>
									<Badge variant="secondary">
										{route.students} {t("transport.students")}
									</Badge>
								</div>
								{canManage && (
									<Button onClick={() => setStopRoute(route)} size="sm" variant="ghost">
										<PlusIcon /> {t("transport.addStop")}
									</Button>
								)}
							</CardHeader>
							<CardContent className="flex flex-col gap-3">
								<div className="flex items-baseline justify-between gap-2">
									<span className="text-sm text-muted-foreground">{t("transport.fee")}</span>
									<span className="font-mono text-sm">{formatTZS(route.feeAmount)}</span>
								</div>
								<div>
									<div className="mb-1 text-sm text-muted-foreground">{t("transport.stops")}</div>
									{route.stops.length === 0 ? (
										<p className="text-sm text-muted-foreground">{t("transport.noStops")}</p>
									) : (
										<ol className="list-decimal pl-5 text-sm">
											{route.stops.map((stop) => (
												<li key={stop.id}>{stop.name}</li>
											))}
										</ol>
									)}
								</div>
								<div>
									<Button onClick={() => setRosterRoute(route)} size="sm" variant="outline">
										<UsersIcon /> {t("transport.roster")}
									</Button>
								</div>
							</CardContent>
						</Card>
					))}
				</div>
			)}

			{canManage && (
				<CreateRouteDialog
					onClose={() => setCreateOpen(false)}
					onSaved={async () => {
						setCreateOpen(false);
						await reload();
					}}
					open={createOpen}
					tenantId={tenantId}
				/>
			)}
			{canManage && stopRoute && (
				<CreateStopDialog
					onClose={() => setStopRoute(null)}
					onSaved={async () => {
						setStopRoute(null);
						await reload();
					}}
					route={stopRoute}
					tenantId={tenantId}
				/>
			)}
			{canManage && academicYear && (
				<AssignDialog
					academicYearId={academicYear.id}
					key={assignOpen ? "open" : "closed"}
					onClose={() => setAssignOpen(false)}
					onSaved={async () => {
						setAssignOpen(false);
						await reload();
					}}
					open={assignOpen}
					routes={routes}
					students={students}
					tenantId={tenantId}
				/>
			)}
			{rosterRoute && (
				<RosterDialog
					onClose={() => setRosterRoute(null)}
					route={rosterRoute}
					tenantId={tenantId}
				/>
			)}
		</div>
	);
}

function CreateRouteDialog({
	tenantId,
	open,
	onClose,
	onSaved,
}: {
	tenantId: string;
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const t = getDict();
	const [name, setName] = useState("");
	const [fee, setFee] = useState("0");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const feeNumber = Number(fee);

	async function save() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/transport/routes", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ name: name.trim(), feeAmount: feeNumber }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setName("");
			setFee("0");
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
					<DialogTitle>{t("transport.addRoute")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("transport.routeName")}
						<Input onChange={(e) => setName(e.target.value)} value={name} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("transport.fee")}
						<Input min={0} onChange={(e) => setFee(e.target.value)} type="number" value={fee} />
						<span className="text-xs text-muted-foreground">{t("transport.feeHint")}</span>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button
							disabled={pending || name.trim().length < 2 || !Number.isFinite(feeNumber) || feeNumber < 0}
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

function CreateStopDialog({
	tenantId,
	route,
	onClose,
	onSaved,
}: {
	tenantId: string;
	route: RouteRow;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const t = getDict();
	const [name, setName] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/transport/stops", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					routeId: route.id,
					name: name.trim(),
					sortOrder: route.stops.length,
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
		<Dialog onOpenChange={(v) => !v && onClose()} open>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t("transport.addStop")} — {route.name}
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("transport.stopName")}
						<Input onChange={(e) => setName(e.target.value)} value={name} />
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button disabled={pending || name.trim() === ""} onClick={() => void save()}>
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function AssignDialog({
	tenantId,
	students,
	routes,
	academicYearId,
	open,
	onClose,
	onSaved,
}: {
	tenantId: string;
	students: StudentOption[];
	routes: RouteRow[];
	academicYearId: string;
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const t = getDict();
	const [query, setQuery] = useState("");
	const [studentId, setStudentId] = useState("");
	const [routeId, setRouteId] = useState("");
	const [stopId, setStopId] = useState("");
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
	const route = routes.find((r) => r.id === routeId) ?? null;

	async function save() {
		if (!studentId || !routeId) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/transport/assignments", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					studentId,
					routeId,
					stopId: stopId === "" ? null : stopId,
					academicYearId,
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(
					body?.code === "TRANSPORT_STOP_MISMATCH"
						? t("transport.err.stopMismatch")
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

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("transport.assign")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("hostel.student")}
						<Input
							onChange={(e) => {
								setQuery(e.target.value);
								setStudentId("");
							}}
							placeholder={t("transport.searchStudent")}
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
						</div>
					)}
					<label className="flex flex-col gap-1 text-sm">
						{t("transport.title")}
						<select
							className={selectClass}
							onChange={(e) => {
								setRouteId(e.target.value);
								setStopId("");
							}}
							value={routeId}
						>
							<option value="">{t("transport.selectRoute")}</option>
							{routes.map((r) => (
								<option key={r.id} value={r.id}>
									{r.name} — {formatTZS(r.feeAmount)}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("transport.stop")}
						<select
							className={selectClass}
							disabled={!route || route.stops.length === 0}
							onChange={(e) => setStopId(e.target.value)}
							value={stopId}
						>
							<option value="">{t("transport.selectStop")}</option>
							{(route?.stops ?? []).map((s) => (
								<option key={s.id} value={s.id}>
									{s.name}
								</option>
							))}
						</select>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button disabled={pending || !studentId || !routeId} onClick={() => void save()}>
							{pending ? t("common.loading") : t("transport.assign")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function RosterDialog({
	tenantId,
	route,
	onClose,
}: {
	tenantId: string;
	route: RouteRow;
	onClose: () => void;
}) {
	const t = getDict();
	const [roster, setRoster] = useState<RosterRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const response = await apiFetch(`/api/v1/transport/routes/${route.id}/students`, {
			tenantId,
		});
		if (!response.ok) {
			setError(`${t("transport.loadFailed")} (HTTP ${response.status})`);
			return;
		}
		setRoster((await response.json()).data);
	}, [route.id, tenantId, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load();
	}, [load]);

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t("transport.roster")} — {route.name}
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					{roster === null ? (
						<p className="text-sm text-muted-foreground">{t("common.loading")}</p>
					) : roster.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("transport.noStudents")}</p>
					) : (
						roster.map((row) => (
							<div
								className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-b-0"
								key={row.assignmentId}
							>
								<div>
									<div className="text-sm font-medium">{row.name}</div>
									<div className="font-mono text-xs text-muted-foreground">
										{row.studentNumber}
									</div>
								</div>
								<span className="text-xs text-muted-foreground">
									{row.stop ?? "—"}
								</span>
							</div>
						))
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
