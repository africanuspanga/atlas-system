"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BanknoteIcon, PlayIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type Lang } from "@/i18n";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

interface StaffOption {
	userId: string;
	fullName: string;
}

interface SalaryRow {
	id: string;
	userId: string;
	fullName: string;
	basic: number;
	allowances: number;
	hasHeslb: boolean;
}

interface RunRow {
	id: string;
	period: string;
	status: string;
	postedAt: string | null;
	employees: number;
	totalGross: number;
	totalNet: number;
}

interface RunDetail {
	id: string;
	period: string;
	status: string;
	items: Array<{
		id: string;
		fullName: string;
		basic: number;
		allowances: number;
		gross: number;
		paye: number;
		nssf: number;
		heslb: number;
		net: number;
	}>;
	totals: {
		basic: number;
		allowances: number;
		gross: number;
		paye: number;
		nssf: number;
		heslb: number;
		net: number;
	};
	employer: { nssf: number; wcf: number; sdl: number };
}

interface PayeBand {
	up_to: number | null;
	rate: number;
}

interface StatutoryRates {
	paye_bands: PayeBand[];
	nssf_employee_rate: number;
	heslb_rate: number;
	employer: {
		nssf_rate: number;
		wcf_rate: number;
		sdl_rate: number;
	};
}

interface SettingsResponse {
	rates: StatutoryRates | null;
	verifiedAt: string | null;
	verifiedBy: string | null;
}

function fmtTZS(amount: number) {
	return `${amount.toLocaleString("en-US")} TZS`;
}

export function PayrollView({
	tenantId,
	canManage,
	lang,
}: {
	tenantId: string;
	canManage: boolean;
	lang: Lang;
}) {
	const t = useMemo(() => getDict(lang), [lang]);
	const [salaries, setSalaries] = useState<SalaryRow[]>([]);
	const [runs, setRuns] = useState<RunRow[]>([]);
	const [staff, setStaff] = useState<StaffOption[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [salaryOpen, setSalaryOpen] = useState(false);
	const [runOpen, setRunOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [detail, setDetail] = useState<RunDetail | null>(null);
	const [detailError, setDetailError] = useState<string | null>(null);
	const [removeTarget, setRemoveTarget] = useState<SalaryRow | null>(null);
	const [discardTarget, setDiscardTarget] = useState<RunRow | null>(null);
	const [rowPending, setRowPending] = useState(false);
	const [rowError, setRowError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoaded(false);
		setLoadError(null);
		try {
			const [salariesRes, runsRes] = await Promise.all([
				apiFetch("/api/v1/payroll/salaries", { tenantId }),
				apiFetch("/api/v1/payroll/runs", { tenantId }),
			]);
			if (!salariesRes.ok || !runsRes.ok) {
				setLoadError(
					`${t("payroll.loadFailed")} (HTTP ${salariesRes.ok ? runsRes.status : salariesRes.status})`,
				);
				return;
			}
			setSalaries((await salariesRes.json()).data);
			setRuns((await runsRes.json()).data);
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

	useEffect(() => {
		if (!canManage) return;
		void (async () => {
			const response = await apiFetch("/api/v1/payroll/staff", { tenantId });
			if (response.ok) setStaff((await response.json()).data);
		})();
	}, [canManage, tenantId]);

	const openDetail = useCallback(
		async (runId: string) => {
			const response = await apiFetch(`/api/v1/payroll/runs/${runId}`, { tenantId });
			if (!response.ok) {
				setDetailError(`${t("payroll.loadFailed")} (HTTP ${response.status})`);
				return;
			}
			setDetailError(null);
			setDetail(await response.json());
		},
		[tenantId, t],
	);

	const removeStaff = useCallback(async () => {
		if (!removeTarget) return;
		setRowPending(true);
		setRowError(null);
		try {
			const response = await apiFetch(
				`/api/v1/payroll/salaries/${removeTarget.userId}/deactivate`,
				{ method: "POST", tenantId },
			);
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setRowError(
					body?.code === "SALARY_NOT_FOUND"
						? t("payroll.salaryNotFound")
						: apiErrorMessage(t, body, response.status),
				);
				return;
			}
			setRemoveTarget(null);
			await reload();
		} catch {
			setRowError(t("common.apiUnreachable"));
		} finally {
			setRowPending(false);
		}
	}, [removeTarget, tenantId, t, reload]);

	const discardRun = useCallback(async () => {
		if (!discardTarget) return;
		setRowPending(true);
		setRowError(null);
		try {
			const response = await apiFetch(
				`/api/v1/payroll/runs/${discardTarget.id}/discard`,
				{ method: "POST", tenantId },
			);
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setRowError(
					body?.code === "PAYROLL_RUN_POSTED"
						? t("payroll.runPosted")
						: apiErrorMessage(t, body, response.status),
				);
				return;
			}
			setDiscardTarget(null);
			await reload();
		} catch {
			setRowError(t("common.apiUnreachable"));
		} finally {
			setRowPending(false);
		}
	}, [discardTarget, tenantId, t, reload]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("payroll.title")}</h1>
				{canManage && (
					<div className="flex gap-2">
						<Button onClick={() => setSettingsOpen(true)} size="sm" variant="outline">
							<SettingsIcon /> {t("payroll.settings.open")}
						</Button>
						<Button onClick={() => setSalaryOpen(true)} size="sm" variant="outline">
							<BanknoteIcon /> {t("payroll.setSalary")}
						</Button>
						<Button onClick={() => setRunOpen(true)} size="sm">
							<PlayIcon /> {t("payroll.runPayroll")}
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
			{detailError && <p className="text-sm text-destructive">{detailError}</p>}

			<Card className="shadow-none">
				<CardHeader>
					<CardTitle className="text-base">{t("payroll.salaries")}</CardTitle>
				</CardHeader>
				<CardContent>
					{!loaded && !loadError ? (
						<ListSkeleton className="border-0 p-0" rows={5} />
					) : loaded && !loadError && salaries.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("payroll.salariesEmpty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("payroll.staffMember")}</TableHead>
									<TableHead className="text-right">{t("payroll.basic")}</TableHead>
									<TableHead className="text-right">{t("payroll.allowances")}</TableHead>
									<TableHead>{t("payroll.heslb")}</TableHead>
									{canManage && <TableHead />}
								</TableRow>
							</TableHeader>
							<TableBody>
								{salaries.map((s) => (
									<TableRow key={s.id}>
										<TableCell className="font-medium">{s.fullName || "—"}</TableCell>
										<TableCell className="text-right font-mono">{fmtTZS(s.basic)}</TableCell>
										<TableCell className="text-right font-mono">
											{fmtTZS(s.allowances)}
										</TableCell>
										<TableCell>
											{s.hasHeslb && <Badge variant="outline">{t("payroll.heslb")}</Badge>}
										</TableCell>
										{canManage && (
											<TableCell className="text-right">
												<Button
													onClick={() => {
														setRowError(null);
														setRemoveTarget(s);
													}}
													size="sm"
													variant="outline"
												>
													<Trash2Icon /> {t("payroll.remove")}
												</Button>
											</TableCell>
										)}
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<Card className="shadow-none">
				<CardHeader>
					<CardTitle className="text-base">{t("payroll.runs")}</CardTitle>
				</CardHeader>
				<CardContent>
					{!loaded && !loadError ? (
						<ListSkeleton className="border-0 p-0" rows={5} />
					) : loaded && !loadError && runs.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("payroll.runsEmpty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("payroll.period")}</TableHead>
									<TableHead>{t("payroll.status")}</TableHead>
									<TableHead className="text-right">{t("payroll.employees")}</TableHead>
									<TableHead className="text-right">{t("payroll.gross")}</TableHead>
									<TableHead className="text-right">{t("payroll.net")}</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{runs.map((r) => (
									<TableRow key={r.id}>
										<TableCell className="font-mono">{r.period}</TableCell>
										<TableCell>
											<Badge variant={r.status === "posted" ? "default" : "outline"}>
												{r.status === "posted" ? t("payroll.posted") : t("payroll.draft")}
											</Badge>
										</TableCell>
										<TableCell className="text-right font-mono">{r.employees}</TableCell>
										<TableCell className="text-right font-mono">
											{fmtTZS(r.totalGross)}
										</TableCell>
										<TableCell className="text-right font-mono">{fmtTZS(r.totalNet)}</TableCell>
										<TableCell className="text-right">
											<div className="flex justify-end gap-2">
												<Button
													onClick={() => void openDetail(r.id)}
													size="sm"
													variant="outline"
												>
													{t("payroll.view")}
												</Button>
												{canManage && r.status === "draft" && (
													<Button
														onClick={() => {
															setRowError(null);
															setDiscardTarget(r);
														}}
														size="sm"
														variant="outline"
													>
														<Trash2Icon /> {t("payroll.discard")}
													</Button>
												)}
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			{canManage && (
				<SetSalaryDialog
					key={salaryOpen ? "open" : "closed"}
					lang={lang}
					onClose={() => setSalaryOpen(false)}
					onSaved={async () => {
						setSalaryOpen(false);
						await reload();
					}}
					open={salaryOpen}
					staff={staff}
					tenantId={tenantId}
				/>
			)}
			{canManage && (
				<RunPayrollDialog
					key={runOpen ? "run-open" : "run-closed"}
					lang={lang}
					onClose={() => setRunOpen(false)}
					onSaved={async () => {
						setRunOpen(false);
						await reload();
					}}
					open={runOpen}
					tenantId={tenantId}
				/>
			)}
			{detail && (
				<RunDetailDialog
					canManage={canManage}
					detail={detail}
					lang={lang}
					onClose={() => setDetail(null)}
					onPosted={async () => {
						setDetail(null);
						await reload();
					}}
					tenantId={tenantId}
				/>
			)}
			{canManage && settingsOpen && (
				<StatutoryRatesDialog
					key="settings-open"
					lang={lang}
					onClose={() => setSettingsOpen(false)}
					tenantId={tenantId}
				/>
			)}
			{canManage && removeTarget && (
				<Dialog onOpenChange={(v) => !v && setRemoveTarget(null)} open>
					<DialogContent className="max-w-sm">
						<DialogHeader>
							<DialogTitle>{t("payroll.removeStaff")}</DialogTitle>
						</DialogHeader>
						<div className="flex flex-col gap-3">
							<p className="text-sm text-muted-foreground">
								{removeTarget.fullName || "—"}
							</p>
							<p className="text-sm text-destructive">{t("payroll.removeConfirm")}</p>
							{rowError && <p className="text-sm text-destructive">{rowError}</p>}
							<div className="flex justify-end gap-2">
								<Button onClick={() => setRemoveTarget(null)} variant="outline">
									{t("common.cancel")}
								</Button>
								<Button disabled={rowPending} onClick={() => void removeStaff()}>
									{rowPending ? t("common.working") : t("payroll.remove")}
								</Button>
							</div>
						</div>
					</DialogContent>
				</Dialog>
			)}
			{canManage && discardTarget && (
				<Dialog onOpenChange={(v) => !v && setDiscardTarget(null)} open>
					<DialogContent className="max-w-sm">
						<DialogHeader>
							<DialogTitle>{t("payroll.discardDraft")}</DialogTitle>
						</DialogHeader>
						<div className="flex flex-col gap-3">
							<p className="font-mono text-sm text-muted-foreground">
								{discardTarget.period}
							</p>
							<p className="text-sm text-destructive">{t("payroll.discardConfirm")}</p>
							{rowError && <p className="text-sm text-destructive">{rowError}</p>}
							<div className="flex justify-end gap-2">
								<Button onClick={() => setDiscardTarget(null)} variant="outline">
									{t("common.cancel")}
								</Button>
								<Button disabled={rowPending} onClick={() => void discardRun()}>
									{rowPending ? t("common.working") : t("payroll.discard")}
								</Button>
							</div>
						</div>
					</DialogContent>
				</Dialog>
			)}
		</div>
	);
}

function SetSalaryDialog({
	tenantId,
	staff,
	open,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	staff: StaffOption[];
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [query, setQuery] = useState("");
	const [userId, setUserId] = useState("");
	const [basic, setBasic] = useState("");
	const [allowances, setAllowances] = useState("");
	const [hasHeslb, setHasHeslb] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const q = query.toLowerCase().trim();
	const matches =
		q === ""
			? staff.slice(0, 8)
			: staff.filter((s) => s.fullName.toLowerCase().includes(q)).slice(0, 8);
	const selected = staff.find((s) => s.userId === userId) ?? null;
	const basicValue = Number(basic);
	const allowancesValue = allowances.trim() === "" ? 0 : Number(allowances);
	const valid =
		userId !== "" &&
		Number.isFinite(basicValue) &&
		basicValue > 0 &&
		Number.isFinite(allowancesValue) &&
		allowancesValue >= 0;

	async function save() {
		if (!valid) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/payroll/salaries", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					userId,
					basic: basicValue,
					allowances: allowancesValue,
					hasHeslb,
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
					<DialogTitle>{t("payroll.setSalary")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("payroll.staffMember")}
						<Input
							onChange={(e) => {
								setQuery(e.target.value);
								setUserId("");
							}}
							placeholder={t("payroll.searchStaff")}
							value={selected ? selected.fullName : query}
						/>
					</label>
					{!selected && (
						<div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
							{matches.map((s) => (
								<button
									className="rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted"
									key={s.userId}
									onClick={() => setUserId(s.userId)}
									type="button"
								>
									{s.fullName || s.userId}
								</button>
							))}
							{matches.length === 0 && (
								<p className="px-2 text-sm text-muted-foreground">{t("payroll.noMatches")}</p>
							)}
						</div>
					)}
					<label className="flex flex-col gap-1 text-sm">
						{`${t("payroll.basic")} (TZS)`}
						<Input
							className="font-mono"
							min="0"
							onChange={(e) => setBasic(e.target.value)}
							type="number"
							value={basic}
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{`${t("payroll.allowances")} (TZS)`}
						<Input
							className="font-mono"
							min="0"
							onChange={(e) => setAllowances(e.target.value)}
							type="number"
							value={allowances}
						/>
					</label>
					<label className="flex items-start gap-2 text-sm">
						<input
							checked={hasHeslb}
							className="mt-0.5 size-4 accent-primary"
							onChange={(e) => setHasHeslb(e.target.checked)}
							type="checkbox"
						/>
						<span className="flex flex-col">
							{t("payroll.heslb")}
							<span className="text-xs text-muted-foreground">{t("payroll.heslbHint")}</span>
						</span>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button disabled={pending || !valid} onClick={() => void save()}>
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function RunPayrollDialog({
	tenantId,
	open,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/payroll/runs", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ period }),
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
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{t("payroll.runPayroll")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("payroll.month")}
						<Input
							className="font-mono"
							onChange={(e) => setPeriod(e.target.value)}
							type="month"
							value={period}
						/>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button
							disabled={pending || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period)}
							onClick={() => void save()}
						>
							{pending ? t("common.loading") : t("payroll.runPayroll")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function RunDetailDialog({
	tenantId,
	detail,
	canManage,
	onClose,
	onPosted,
	lang,
}: {
	tenantId: string;
	detail: RunDetail;
	canManage: boolean;
	onClose: () => void;
	onPosted: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [confirming, setConfirming] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function post() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/payroll/runs/${detail.id}/post`, {
				method: "POST",
				tenantId,
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(
					body?.code === "PAYROLL_RUN_STALE"
						? t("payroll.runStale")
						: apiErrorMessage(t, body, response.status),
				);
				return;
			}
			await onPosted();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open>
			<DialogContent className="max-w-4xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{t("payroll.period")} <span className="font-mono">{detail.period}</span>
						<Badge variant={detail.status === "posted" ? "default" : "outline"}>
							{detail.status === "posted" ? t("payroll.posted") : t("payroll.draft")}
						</Badge>
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="max-h-96 overflow-y-auto">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("payroll.staffMember")}</TableHead>
									<TableHead className="text-right">{t("payroll.basic")}</TableHead>
									<TableHead className="text-right">{t("payroll.allowances")}</TableHead>
									<TableHead className="text-right">{t("payroll.gross")}</TableHead>
									<TableHead className="text-right">PAYE</TableHead>
									<TableHead className="text-right">NSSF</TableHead>
									<TableHead className="text-right">{t("payroll.heslb")}</TableHead>
									<TableHead className="text-right">{t("payroll.net")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{detail.items.map((i) => (
									<TableRow key={i.id}>
										<TableCell className="font-medium">{i.fullName || "—"}</TableCell>
										<TableCell className="text-right font-mono">
											{i.basic.toLocaleString("en-US")}
										</TableCell>
										<TableCell className="text-right font-mono">
											{i.allowances.toLocaleString("en-US")}
										</TableCell>
										<TableCell className="text-right font-mono">
											{i.gross.toLocaleString("en-US")}
										</TableCell>
										<TableCell className="text-right font-mono">
											{i.paye.toLocaleString("en-US")}
										</TableCell>
										<TableCell className="text-right font-mono">
											{i.nssf.toLocaleString("en-US")}
										</TableCell>
										<TableCell className="text-right font-mono">
											{i.heslb.toLocaleString("en-US")}
										</TableCell>
										<TableCell className="text-right font-mono">
											{i.net.toLocaleString("en-US")}
										</TableCell>
									</TableRow>
								))}
								<TableRow>
									<TableCell className="font-semibold">{t("payroll.total")}</TableCell>
									<TableCell className="text-right font-mono font-semibold">
										{detail.totals.basic.toLocaleString("en-US")}
									</TableCell>
									<TableCell className="text-right font-mono font-semibold">
										{detail.totals.allowances.toLocaleString("en-US")}
									</TableCell>
									<TableCell className="text-right font-mono font-semibold">
										{detail.totals.gross.toLocaleString("en-US")}
									</TableCell>
									<TableCell className="text-right font-mono font-semibold">
										{detail.totals.paye.toLocaleString("en-US")}
									</TableCell>
									<TableCell className="text-right font-mono font-semibold">
										{detail.totals.nssf.toLocaleString("en-US")}
									</TableCell>
									<TableCell className="text-right font-mono font-semibold">
										{detail.totals.heslb.toLocaleString("en-US")}
									</TableCell>
									<TableCell className="text-right font-mono font-semibold">
										{detail.totals.net.toLocaleString("en-US")}
									</TableCell>
								</TableRow>
							</TableBody>
						</Table>
					</div>

					<p className="text-xs text-muted-foreground">
						{t("payroll.employerNote")}: NSSF{" "}
						<span className="font-mono">{fmtTZS(detail.employer.nssf)}</span> · WCF{" "}
						<span className="font-mono">{fmtTZS(detail.employer.wcf)}</span> · SDL{" "}
						<span className="font-mono">{fmtTZS(detail.employer.sdl)}</span>
					</p>

					{error && <p className="text-sm text-destructive">{error}</p>}

					{canManage && detail.status === "draft" && (
						<div className="flex flex-col items-end gap-2">
							{confirming ? (
								<>
									<p className="text-sm text-destructive">{t("payroll.postWarning")}</p>
									<div className="flex gap-2">
										<Button onClick={() => setConfirming(false)} variant="outline">
											{t("common.cancel")}
										</Button>
										<Button disabled={pending} onClick={() => void post()}>
											{pending ? t("common.working") : t("common.confirm")}
										</Button>
									</div>
								</>
							) : (
								<Button onClick={() => setConfirming(true)}>
									{t("payroll.postToLedger")}
								</Button>
							)}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function StatutoryRatesDialog({
	tenantId,
	onClose,
	lang,
}: {
	tenantId: string;
	onClose: () => void;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [rates, setRates] = useState<StatutoryRates | null>(null);
	const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
	const [verifiedBy, setVerifiedBy] = useState<string | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		void (async () => {
			try {
				const response = await apiFetch("/api/v1/payroll/settings", { tenantId });
				if (!active) return;
				if (!response.ok) {
					setError(`${t("payroll.loadFailed")} (HTTP ${response.status})`);
					setLoaded(true);
					return;
				}
				const body: SettingsResponse = await response.json();
				setRates(body.rates);
				setVerifiedAt(body.verifiedAt);
				setVerifiedBy(body.verifiedBy);
				setLoaded(true);
			} catch {
				if (active) {
					setError(t("common.apiUnreachable"));
					setLoaded(true);
				}
			}
		})();
		return () => {
			active = false;
		};
		// t is stable for a given lang; tenantId identifies the fetch.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [tenantId]);

	function patchRate<K extends keyof StatutoryRates>(key: K, value: StatutoryRates[K]) {
		setRates((prev) => (prev ? { ...prev, [key]: value } : prev));
	}

	function patchBand(index: number, key: keyof PayeBand, raw: string) {
		const numeric = raw.trim() === "" ? null : Number(raw);
		if (numeric !== null && !Number.isFinite(numeric)) return;
		setRates((prev) => {
			if (!prev) return prev;
			const paye_bands = prev.paye_bands.map((band, i) =>
				i === index
					? key === "up_to"
						? { ...band, up_to: numeric }
						: { ...band, rate: (numeric ?? 0) / 100 }
					: band,
			);
			return { ...prev, paye_bands };
		});
	}

	function patchEmployer(key: keyof StatutoryRates["employer"], value: number) {
		setRates((prev) =>
			prev ? { ...prev, employer: { ...prev.employer, [key]: value } } : prev,
		);
	}

	async function save() {
		if (!rates || !confirmed) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/payroll/settings", {
				method: "PUT",
				tenantId,
				body: JSON.stringify({ rates, verified: true }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(
					body?.code === "PAYROLL_SETTINGS_INVALID"
						? t("payroll.settings.invalid")
						: apiErrorMessage(t, body, response.status),
				);
				return;
			}
			onClose();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("payroll.settings.title")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<p className="text-sm text-muted-foreground">{t("payroll.settings.intro")}</p>

					<Badge className="self-start" variant={verifiedAt ? "default" : "outline"}>
						{verifiedAt
							? t("payroll.settings.verified")
									.replace("{when}", new Date(verifiedAt).toLocaleDateString("en-GB"))
									.replace("{who}", verifiedBy ?? "—")
							: t("payroll.settings.unverified")}
					</Badge>

					{!loaded ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("common.loading")}
						</p>
					) : !rates ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("payroll.settings.noRates")}
						</p>
					) : (
						<div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
							<div className="flex flex-col gap-2">
								<span className="text-sm font-medium">
									{t("payroll.settings.payeBands")}
								</span>
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>{t("payroll.settings.payeFrom")}</TableHead>
											<TableHead>{t("payroll.settings.payeRate")}</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{rates.paye_bands.map((band, i) => (
											<TableRow key={i}>
												<TableCell>
													<Input
														className="font-mono"
														min="0"
													onChange={(e) => patchBand(i, "up_to", e.target.value)}
													type="number"
													value={band.up_to ?? ""}
													/>
												</TableCell>
												<TableCell>
													<Input
														className="font-mono"
														max="100"
														min="0"
														onChange={(e) => patchBand(i, "rate", e.target.value)}
														type="number"
														value={band.rate * 100}
													/>
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>

							<div className="grid grid-cols-2 gap-3">
								<RateField
									label={t("payroll.settings.nssf")}
									onChange={(v) => patchRate("nssf_employee_rate", v)}
									value={rates.nssf_employee_rate}
								/>
								<RateField
									label={t("payroll.settings.nssfEmployer")}
									onChange={(v) => patchEmployer("nssf_rate", v)}
									value={rates.employer.nssf_rate}
								/>
								<RateField
									label={t("payroll.settings.heslb")}
									onChange={(v) => patchRate("heslb_rate", v)}
									value={rates.heslb_rate}
								/>
								<RateField
									label={t("payroll.settings.wcf")}
									onChange={(v) => patchEmployer("wcf_rate", v)}
									value={rates.employer.wcf_rate}
								/>
								<RateField
									label={t("payroll.settings.sdl")}
									onChange={(v) => patchEmployer("sdl_rate", v)}
									value={rates.employer.sdl_rate}
								/>
							</div>
						</div>
					)}

					{error && <p className="text-sm text-destructive">{error}</p>}

					{loaded && rates && (
						<>
							<label className="flex items-start gap-2 text-sm">
								<input
									checked={confirmed}
									className="mt-0.5 size-4 accent-primary"
									onChange={(e) => setConfirmed(e.target.checked)}
									type="checkbox"
								/>
								<span>{t("payroll.settings.verify")}</span>
							</label>
							<div className="flex justify-end">
								<Button disabled={pending || !confirmed} onClick={() => void save()}>
									{pending ? t("common.working") : t("payroll.settings.save")}
								</Button>
							</div>
						</>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function RateField({
	label,
	value,
	onChange,
}: {
	label: string;
	value: number;
	onChange: (value: number) => void;
}) {
	return (
		<label className="flex flex-col gap-1 text-sm">
			{label}
			<Input
				className="font-mono"
				max="100"
				min="0"
				onChange={(e) => {
					const raw = e.target.value;
					const next = raw.trim() === "" ? 0 : Number(raw);
					if (Number.isFinite(next)) onChange(next / 100);
				}}
				step="0.01"
				type="number"
				value={value * 100}
			/>
		</label>
	);
}
