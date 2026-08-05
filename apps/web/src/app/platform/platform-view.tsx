"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BuildingIcon, RefreshCwIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { todayInTanzania } from "@/lib/tanzania-date";
import { getDict } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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

interface Overview {
	tenantsByStatus: Record<string, number>;
	subscriptionsByStatus: Record<string, number>;
	totals: Record<string, number>;
	monthlyRecurringRevenueTzs: number;
	smsSentThisMonth: number;
	smsFailedTotal: number;
	importJobsByStatus: Record<string, number>;
	reportJobsByStatus: Record<string, number>;
}

interface TenantRow {
	id: string;
	name: string;
	slug: string;
	status: string;
	region: string | null;
	created_at: string;
	subscriptions: Array<{
		status: string;
		trial_ends_at: string | null;
		current_period_end: string | null;
		plans: { key: string; name: string } | null;
	}>;
}

interface AuditEntry {
	id: string;
	action: string;
	tenant_id: string | null;
	details: Record<string, unknown> | null;
	created_at: string;
	actor: { full_name: string } | null;
	tenant: { name: string; slug: string } | null;
}

interface Plan {
	key: string;
	name: string;
	monthly_price_tzs: number | null;
	limits: Record<string, number | null>;
}

interface RevenuePlanRow {
	planKey: string;
	planName: string;
	monthlyPriceTzs: number | null;
	tenants: number;
	payingTenants: number;
	mrrTzs: number;
}

interface Revenue {
	perPlan: RevenuePlanRow[];
	mrrTzs: number;
	payingTenants: number;
	subscriptionsByStatus: Record<string, number>;
	trialsExpiringSoon: Array<{
		tenantId: string;
		tenantName: string;
		trialEndsAt: string;
	}>;
	tenantsByStatus: Record<string, number>;
}

interface HealthTenant {
	tenantId: string;
	name: string;
	status: string;
	planKey: string | null;
	students: number;
	staff: number;
	attendanceSessions7d: number;
	assessmentScores7d: number;
	payments7d: number;
	aiMessages7d: number;
	lastActivityAt: string | null;
	health: "active" | "quiet" | "silent";
}

interface HealthData {
	tenants: HealthTenant[];
}

interface UnitCostRow {
	tenantId: string;
	name: string;
	status: string;
	planKey: string | null;
	planMonthlyPriceTzs: number | null;
	smsQueued: number;
	aiRequests: number;
	aiTokens: number;
}

interface UnitCosts {
	from: string;
	to: string;
	tenants: UnitCostRow[];
}

/** Tenant lifecycle funnel, in onboarding order (mig 0001 check constraint). */
const PIPELINE_STATUSES = [
	"draft",
	"configuration",
	"data_review",
	"training",
	"live",
] as const;

const HEALTH_VARIANT: Record<
	HealthTenant["health"],
	"default" | "secondary" | "outline"
> = {
	active: "default",
	quiet: "secondary",
	silent: "outline",
};

/** Suspension can hit a school mid-onboarding — reactivate to where it was. */
const REACTIVATE_STATUSES = PIPELINE_STATUSES;

const todayIso = () => todayInTanzania();
const monthStartIso = () => `${todayIso().slice(0, 8)}01`;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
	live: "default",
	suspended: "destructive",
	archived: "outline",
};

export function PlatformView() {
	const t = getDict();
	const [overview, setOverview] = useState<Overview | null>(null);
	const [tenants, setTenants] = useState<TenantRow[]>([]);
	const [plans, setPlans] = useState<Plan[]>([]);
	const [revenue, setRevenue] = useState<Revenue | null>(null);
	const [health, setHealth] = useState<HealthData | null>(null);
	const [costs, setCosts] = useState<UnitCosts | null>(null);
	const [costsError, setCostsError] = useState<string | null>(null);
	const [costFrom, setCostFrom] = useState(monthStartIso);
	const [costTo, setCostTo] = useState(todayIso);
	const [forbidden, setForbidden] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [action, setAction] = useState<{ kind: string; tenant: TenantRow } | null>(null);
	const [reason, setReason] = useState("");
	const [planKey, setPlanKey] = useState("");
	const [cycle, setCycle] = useState<"monthly" | "annual">("monthly");
	const [days, setDays] = useState("30");
	const [months, setMonths] = useState("1");
	const [reference, setReference] = useState("");
	const [force, setForce] = useState(false);
	const [targetStatus, setTargetStatus] = useState("live");
	const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
	const [auditError, setAuditError] = useState<string | null>(null);
	const [auditTenant, setAuditTenant] = useState("");
	const [pending, setPending] = useState(false);

	const reload = useCallback(async () => {
		setError(null);
		try {
			const [ovRes, tRes, pRes, revRes, hRes] = await Promise.all([
				apiFetch("/api/v1/platform/overview"),
				apiFetch("/api/v1/platform/tenants"),
				apiFetch("/api/v1/platform/plans"),
				apiFetch("/api/v1/platform/revenue"),
				apiFetch("/api/v1/platform/health"),
			]);
			if (ovRes.status === 403) {
				setForbidden(true);
				return;
			}
			if (ovRes.ok) setOverview((await ovRes.json()) as Overview);
			if (tRes.ok) setTenants(((await tRes.json()) as { tenants: TenantRow[] }).tenants);
			if (pRes.ok) setPlans(((await pRes.json()) as { plans: Plan[] }).plans);
			if (revRes.ok) setRevenue((await revRes.json()) as Revenue);
			if (hRes.ok) setHealth((await hRes.json()) as HealthData);

			const failed = [
				["overview", ovRes],
				["tenants", tRes],
				["plans", pRes],
				["revenue", revRes],
				["health", hRes],
			]
				.filter(([, res]) => !(res as Response).ok)
				.map(([name]) => name as string);
			if (failed.length > 0) {
				setError(`Failed to load: ${failed.join(", ")}`);
			}
		} catch {
			setError(t("common.apiUnreachable"));
		}
	}, [t]);

	const loadCosts = useCallback(
		async (from: string, to: string) => {
			if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) return;
			try {
				const res = await apiFetch(`/api/v1/platform/unit-costs?from=${from}&to=${to}`);
				if (res.ok) {
					setCostsError(null);
					setCosts((await res.json()) as UnitCosts);
				} else {
					setCosts(null);
					setCostsError(`HTTP ${res.status}`);
				}
			} catch {
				setCosts(null);
				setCostsError(t("common.apiUnreachable"));
			}
		},
		[t],
	);

	const loadAudit = useCallback(
		async (tenantFilter: string) => {
			const trimmed = tenantFilter.trim();
			if (trimmed !== "" && !UUID_RE.test(trimmed)) return;
			try {
				const res = await apiFetch(
					`/api/v1/platform/audit${trimmed ? `?tenantId=${trimmed}` : ""}`,
				);
				if (res.ok) {
					setAuditError(null);
					setAuditEntries(
						((await res.json()) as { entries: AuditEntry[] }).entries,
					);
				} else {
					setAuditEntries([]);
					setAuditError(`HTTP ${res.status}`);
				}
			} catch {
				setAuditEntries([]);
				setAuditError(t("common.apiUnreachable"));
			}
		},
		[t],
	);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reload();
	}, [reload]);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void loadCosts(costFrom, costTo);
	}, [loadCosts, costFrom, costTo]);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void loadAudit(auditTenant);
	}, [loadAudit, auditTenant]);

	async function runAction() {
		if (!action) return;
		setPending(true);
		setError(null);
		try {
			const paths: Record<string, { path: string; body?: unknown }> = {
				suspend: { path: "suspend", body: { reason } },
				reactivate: { path: "reactivate", body: { targetStatus } },
				archive: {
					path: "archive",
					body: { reason, ...(force ? { force: true } : {}) },
				},
				plan: { path: "plan", body: { planKey, cycle } },
				trial: { path: "trial-extend", body: { days: Number(days) } },
				payment: {
					path: "record-payment",
					body: { months: Number(months), reference, reason },
				},
			};
			const def = paths[action.kind];
			const res = await apiFetch(`/api/v1/platform/tenants/${action.tenant.id}/${def.path}`, {
				method: "POST",
				body: def.body ? JSON.stringify(def.body) : undefined,
			});
			const body = (await res.json().catch(() => null)) as { code?: string } | null;
			if (!res.ok) {
				setError(body?.code ?? `HTTP ${res.status}`);
				return;
			}
			setAction(null);
			setReason("");
			setReference("");
			setForce(false);
			void reload();
			void loadAudit(auditTenant);
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	if (forbidden) {
		return (
			<div className="flex min-h-svh flex-col items-center justify-center gap-3 p-6 text-center">
				<BuildingIcon className="size-8 text-muted-foreground" />
				<h1 className="text-lg font-semibold">ATLAS Control Centre</h1>
				<p className="max-w-sm text-sm text-muted-foreground">
					This area is for ATLAS platform staff only. Your account has no platform role.
				</p>
				<Button variant="outline" render={<Link href="/dashboard" />}>
					Back to the school dashboard
				</Button>
			</div>
		);
	}

	const sub = (t: TenantRow) => t.subscriptions?.[0];

	return (
		<div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-8">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold">ATLAS Control Centre</h1>
					<p className="text-sm text-muted-foreground">
						Platform overview, tenants, subscriptions.
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => void reload()}>
					<RefreshCwIcon className="mr-1 size-4" /> Refresh
				</Button>
			</div>

			{error && (
				<div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
					{error}
				</div>
			)}

			{overview && (
				<div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
					<Metric label="Schools" value={overview.totals.tenants} />
					<Metric label="Live schools" value={overview.tenantsByStatus.live ?? 0} />
					<Metric label="Suspended" value={overview.tenantsByStatus.suspended ?? 0} />
					<Metric label="Students" value={overview.totals.students} />
					<Metric label="Staff users" value={overview.totals.staff} />
					<Metric label="Linked parents" value={overview.totals.linkedParents} />
					<Metric
						label="MRR (TZS)"
						value={overview.monthlyRecurringRevenueTzs}
						format="money"
					/>
					<Metric label="SMS this month" value={overview.smsSentThisMonth} />
					<Metric label="SMS failed (all time)" value={overview.smsFailedTotal} />
					<Metric label="Trialing" value={overview.subscriptionsByStatus.trialing ?? 0} />
					<Metric label="Active subs" value={overview.subscriptionsByStatus.active ?? 0} />
					<Metric
						label="Failed imports"
						value={overview.importJobsByStatus.failed ?? 0}
					/>
				</div>
			)}

			{revenue && (
				<section className="flex flex-col gap-3">
					<h2 className="text-sm font-semibold">Revenue</h2>
					<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
						<Metric label="MRR (TZS)" value={revenue.mrrTzs} format="money" />
						<Metric label="Paying tenants" value={revenue.payingTenants} />
						<Metric
							label="Trials active"
							value={revenue.subscriptionsByStatus.trialing ?? 0}
						/>
						<Metric
							label="Trials expiring ≤14d"
							value={revenue.trialsExpiringSoon.length}
							tone={revenue.trialsExpiringSoon.length > 0 ? "down" : undefined}
						/>
					</div>
					<Card>
						<CardHeader>
							<CardTitle className="text-base">MRR by plan</CardTitle>
						</CardHeader>
						<CardContent>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Plan</TableHead>
										<TableHead className="text-right">Tenants</TableHead>
										<TableHead className="text-right">Paying</TableHead>
										<TableHead className="text-right">Price (TZS/mo)</TableHead>
										<TableHead className="text-right">Subtotal (TZS)</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{revenue.perPlan.map((p) => (
										<TableRow key={p.planKey}>
											<TableCell className="font-medium">{p.planName}</TableCell>
											<TableCell className="text-right font-mono">{p.tenants}</TableCell>
											<TableCell className="text-right font-mono">{p.payingTenants}</TableCell>
											<TableCell className="text-right font-mono">
												{p.monthlyPriceTzs != null ? Number(p.monthlyPriceTzs).toLocaleString() : "—"}
											</TableCell>
											<TableCell className="text-right font-mono">
												{Number(p.mrrTzs).toLocaleString()}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
							{revenue.trialsExpiringSoon.length > 0 && (
								<div className="mt-3 flex flex-col gap-1 border-t pt-3">
									<div className="text-xs font-semibold text-down">
										Trials expiring within 14 days
									</div>
									{revenue.trialsExpiringSoon.map((tr) => (
										<div key={tr.tenantId} className="flex justify-between text-sm">
											<span>{tr.tenantName}</span>
											<span className="font-mono text-muted-foreground">
												{new Date(tr.trialEndsAt).toLocaleDateString()}
											</span>
										</div>
									))}
								</div>
							)}
						</CardContent>
					</Card>
				</section>
			)}

			{revenue && (
				<section className="flex flex-col gap-3">
					<h2 className="text-sm font-semibold">Pipeline</h2>
					<div className="flex flex-wrap items-center gap-3">
						{PIPELINE_STATUSES.map((s, i) => (
							<div key={s} className="flex items-center gap-3">
								{i > 0 && <span className="text-muted-foreground">→</span>}
								<Card>
									<CardContent className="flex items-center gap-2 p-3">
										<span className="text-xs text-muted-foreground">{s}</span>
										<span className="font-mono text-lg">
											{revenue.tenantsByStatus[s] ?? 0}
										</span>
									</CardContent>
								</Card>
							</div>
						))}
						<div className="ml-auto flex items-center gap-2">
							<Badge variant="destructive">
								suspended {revenue.tenantsByStatus.suspended ?? 0}
							</Badge>
							<Badge variant="outline">
								archived {revenue.tenantsByStatus.archived ?? 0}
							</Badge>
						</div>
					</div>
				</section>
			)}

			{health && (
				<Card>
					<CardHeader>
						<CardTitle className="text-base">School health (last 7 days)</CardTitle>
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>School</TableHead>
									<TableHead>Plan</TableHead>
									<TableHead className="text-right">Students</TableHead>
									<TableHead className="text-right">Staff</TableHead>
									<TableHead className="text-right">Registers</TableHead>
									<TableHead className="text-right">Marks</TableHead>
									<TableHead className="text-right">Payments</TableHead>
									<TableHead className="text-right">AI</TableHead>
									<TableHead>Last active</TableHead>
									<TableHead>Health</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{health.tenants.map((h) => (
									<TableRow key={h.tenantId}>
										<TableCell>
											<div className="font-medium">{h.name}</div>
											<div className="text-xs text-muted-foreground">{h.status}</div>
										</TableCell>
										<TableCell>{h.planKey ?? "—"}</TableCell>
										<TableCell className="text-right font-mono">{h.students}</TableCell>
										<TableCell className="text-right font-mono">{h.staff}</TableCell>
										<TableCell className="text-right font-mono">{h.attendanceSessions7d}</TableCell>
										<TableCell className="text-right font-mono">{h.assessmentScores7d}</TableCell>
										<TableCell className="text-right font-mono">{h.payments7d}</TableCell>
										<TableCell className="text-right font-mono">{h.aiMessages7d}</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{h.lastActivityAt
												? new Date(h.lastActivityAt).toLocaleDateString()
												: "never"}
										</TableCell>
										<TableCell>
											<Badge
												variant={HEALTH_VARIANT[h.health]}
												className={h.health === "silent" ? "text-down" : undefined}
											>
												{h.health}
											</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<CardTitle className="text-base">Unit costs</CardTitle>
						<div className="flex items-center gap-2 text-sm">
							<Input
								type="date"
								className="h-8 w-36"
								value={costFrom}
								onChange={(e) => setCostFrom(e.target.value)}
							/>
							<span className="text-muted-foreground">to</span>
							<Input
								type="date"
								className="h-8 w-36"
								value={costTo}
								onChange={(e) => setCostTo(e.target.value)}
							/>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{costs ? (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>School</TableHead>
									<TableHead>Plan</TableHead>
									<TableHead className="text-right">SMS queued</TableHead>
									<TableHead className="text-right">AI requests</TableHead>
									<TableHead className="text-right">AI tokens</TableHead>
									<TableHead className="text-right">Plan price (TZS/mo)</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{costs.tenants.map((c) => (
									<TableRow key={c.tenantId}>
										<TableCell className="font-medium">{c.name}</TableCell>
										<TableCell>{c.planKey ?? "—"}</TableCell>
										<TableCell className="text-right font-mono">{c.smsQueued}</TableCell>
										<TableCell className="text-right font-mono">{c.aiRequests}</TableCell>
										<TableCell className="text-right font-mono">
											{Number(c.aiTokens).toLocaleString()}
										</TableCell>
										<TableCell className="text-right font-mono">
											{c.planMonthlyPriceTzs != null
												? Number(c.planMonthlyPriceTzs).toLocaleString()
												: "—"}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					) : costsError ? (
						<p className="text-sm text-destructive">{costsError}</p>
					) : (
						<p className="text-sm text-muted-foreground">No data for this range.</p>
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Tenants</CardTitle>
				</CardHeader>
				<CardContent>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>School</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Plan</TableHead>
								<TableHead>Subscription</TableHead>
								<TableHead>Trial ends</TableHead>
								<TableHead>Paid until</TableHead>
								<TableHead />
							</TableRow>
						</TableHeader>
						<TableBody>
							{tenants.map((t) => (
								<TableRow key={t.id}>
									<TableCell>
										<div className="font-medium">{t.name}</div>
										<div className="text-xs text-muted-foreground">{t.slug}</div>
									</TableCell>
									<TableCell>
										<Badge variant={STATUS_VARIANT[t.status] ?? "secondary"}>{t.status}</Badge>
									</TableCell>
									<TableCell>{sub(t)?.plans?.name ?? "—"}</TableCell>
									<TableCell>{sub(t)?.status ?? "—"}</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{sub(t)?.trial_ends_at
											? new Date(sub(t)!.trial_ends_at!).toLocaleDateString()
											: "—"}
									</TableCell>
									<TableCell className="text-sm text-muted-foreground">
										{sub(t)?.current_period_end
											? new Date(sub(t)!.current_period_end!).toLocaleDateString()
											: "—"}
									</TableCell>
									<TableCell className="space-x-1 text-right">
										{t.status === "suspended" ? (
											<Button
												size="sm"
												variant="outline"
												onClick={() => {
													setTargetStatus("live");
													setAction({ kind: "reactivate", tenant: t });
												}}
											>
												Reactivate
											</Button>
										) : (
											t.status !== "archived" && (
												<Button
													size="sm"
													variant="outline"
													onClick={() => setAction({ kind: "suspend", tenant: t })}
												>
													Suspend
												</Button>
											)
										)}
										{t.status !== "archived" && (
											<>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														setPlanKey(sub(t)?.plans?.key ?? "");
														setCycle("monthly");
														setAction({ kind: "plan", tenant: t });
													}}
												>
													Plan
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => setAction({ kind: "trial", tenant: t })}
												>
													Extend trial
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														setMonths("1");
														setReference("");
														setReason("");
														setAction({ kind: "payment", tenant: t });
													}}
												>
													Record payment
												</Button>
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														setReason("");
														setForce(false);
														setAction({ kind: "archive", tenant: t });
													}}
												>
													Archive
												</Button>
											</>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<CardTitle className="text-base">Platform audit trail</CardTitle>
						<Input
							className="h-8 w-80 font-mono text-xs"
							placeholder="Filter by tenant ID (UUID)"
							value={auditTenant}
							onChange={(e) => setAuditTenant(e.target.value)}
						/>
					</div>
				</CardHeader>
				<CardContent>
					{auditError ? (
						<p className="text-sm text-destructive">{auditError}</p>
					) : auditEntries.length === 0 ? (
						<p className="text-sm text-muted-foreground">No platform actions recorded yet.</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>When</TableHead>
									<TableHead>Actor</TableHead>
									<TableHead>Action</TableHead>
									<TableHead>School</TableHead>
									<TableHead>Reason</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{auditEntries.map((entry) => (
									<TableRow key={entry.id}>
										<TableCell className="text-sm text-muted-foreground">
											{new Date(entry.created_at).toLocaleString()}
										</TableCell>
										<TableCell>{entry.actor?.full_name ?? "—"}</TableCell>
										<TableCell className="font-mono text-xs">{entry.action}</TableCell>
										<TableCell>{entry.tenant?.name ?? "—"}</TableCell>
										<TableCell className="text-sm text-muted-foreground">
											{typeof entry.details?.reason === "string" ? entry.details.reason : "—"}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<Dialog open={action !== null} onOpenChange={(open) => !open && setAction(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{action?.kind === "suspend" && `Suspend ${action.tenant.name}`}
							{action?.kind === "reactivate" && `Reactivate ${action.tenant.name}`}
							{action?.kind === "archive" && `Archive ${action.tenant.name}`}
							{action?.kind === "plan" && `Change plan — ${action?.tenant.name}`}
							{action?.kind === "trial" && `Extend trial — ${action?.tenant.name}`}
							{action?.kind === "payment" && `Record payment — ${action?.tenant.name}`}
						</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						{action?.kind === "suspend" && (
							<>
								<p className="text-sm text-muted-foreground">
									All school access stops immediately. A written reason is required and audited.
								</p>
								<Input
									placeholder="Reason (required)"
									value={reason}
									onChange={(e) => setReason(e.target.value)}
								/>
							</>
						)}
						{action?.kind === "reactivate" && (
							<>
								<p className="text-sm text-muted-foreground">
									Restore the school to its lifecycle stage — a school suspended
									mid-onboarding should not jump straight to live.
								</p>
								<select
									className="h-9 rounded-md border bg-transparent px-2 text-sm"
									value={targetStatus}
									onChange={(e) => setTargetStatus(e.target.value)}
								>
									{REACTIVATE_STATUSES.map((s) => (
										<option key={s} value={s}>
											{s}
										</option>
									))}
								</select>
							</>
						)}
						{action?.kind === "archive" && (
							<>
								<p className="text-sm text-muted-foreground">
									Archiving removes the school from operation permanently (data is
									retained — tenants are never deleted). A written reason is required
									and audited.
								</p>
								<Input
									placeholder="Reason (required)"
									value={reason}
									onChange={(e) => setReason(e.target.value)}
								/>
								{action.tenant.status === "live" && (
									<label className="flex items-center gap-2 text-sm text-destructive">
										<input
											type="checkbox"
											checked={force}
											onChange={(e) => setForce(e.target.checked)}
										/>
										This school is LIVE (a paying customer) — archive it anyway.
									</label>
								)}
							</>
						)}
						{action?.kind === "plan" && (
							<>
								<select
									className="h-9 rounded-md border bg-transparent px-2 text-sm"
									value={planKey}
									onChange={(e) => setPlanKey(e.target.value)}
								>
									<option value="">— select plan —</option>
									{plans.map((p) => (
										<option key={p.key} value={p.key}>
											{p.name} ({p.monthly_price_tzs ? `TZS ${Number(p.monthly_price_tzs).toLocaleString()}/mo` : "free"})
										</option>
									))}
								</select>
								<select
									className="h-9 rounded-md border bg-transparent px-2 text-sm"
									value={cycle}
									onChange={(e) => setCycle(e.target.value as "monthly" | "annual")}
								>
									<option value="monthly">Monthly billing (1 month)</option>
									<option value="annual">Annual billing (12 months)</option>
								</select>
								<p className="text-sm text-muted-foreground">
									The current subscription is closed and a new paid period starts today.
								</p>
							</>
						)}
						{action?.kind === "payment" && (
							<>
								<p className="text-sm text-muted-foreground">
									Extends the paid period by N months from today or the current period
									end, whichever is later. Use the bank / M-Pesa reference.
								</p>
								<Input
									type="number"
									min={1}
									max={24}
									placeholder="Months paid"
									value={months}
									onChange={(e) => setMonths(e.target.value)}
								/>
								<Input
									placeholder="Payment reference (required)"
									value={reference}
									onChange={(e) => setReference(e.target.value)}
								/>
								<Input
									placeholder="Reason (required)"
									value={reason}
									onChange={(e) => setReason(e.target.value)}
								/>
							</>
						)}
						{action?.kind === "trial" && (
							<Input
								type="number"
								min={1}
								max={180}
								value={days}
								onChange={(e) => setDays(e.target.value)}
							/>
						)}
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => setAction(null)}>
								{t("common.cancel")}
							</Button>
							<Button
								onClick={() => void runAction()}
								disabled={
									pending ||
									((action?.kind === "suspend" || action?.kind === "archive") &&
										reason.trim().length < 5) ||
									(action?.kind === "archive" &&
										action.tenant.status === "live" &&
										!force) ||
									(action?.kind === "plan" && !planKey) ||
									(action?.kind === "payment" &&
										(!Number.isInteger(Number(months)) ||
											Number(months) < 1 ||
											Number(months) > 24 ||
											reference.trim().length < 3 ||
											reason.trim().length < 5))
								}
							>
								{pending ? t("common.working") : t("common.confirm")}
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function Metric({
	label,
	value,
	format,
	tone,
}: {
	label: string;
	value: number;
	format?: "money";
	tone?: "down";
}) {
	return (
		<Card>
			<CardContent className="p-3">
				<div className="text-xs text-muted-foreground">{label}</div>
				<div
					className={`text-lg font-semibold ${format === "money" ? "font-mono" : ""} ${tone === "down" ? "text-down" : ""}`}
				>
					{format === "money" ? Number(value).toLocaleString() : value}
				</div>
			</CardContent>
		</Card>
	);
}
