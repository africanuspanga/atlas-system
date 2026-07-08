"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BuildingIcon, RefreshCwIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
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
		plans: { key: string; name: string } | null;
	}>;
}

interface Plan {
	key: string;
	name: string;
	monthly_price_tzs: number | null;
	limits: Record<string, number | null>;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
	live: "default",
	suspended: "destructive",
	archived: "outline",
};

export function PlatformView() {
	const [overview, setOverview] = useState<Overview | null>(null);
	const [tenants, setTenants] = useState<TenantRow[]>([]);
	const [plans, setPlans] = useState<Plan[]>([]);
	const [forbidden, setForbidden] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [action, setAction] = useState<{ kind: string; tenant: TenantRow } | null>(null);
	const [reason, setReason] = useState("");
	const [planKey, setPlanKey] = useState("");
	const [days, setDays] = useState("30");
	const [pending, setPending] = useState(false);

	const reload = useCallback(async () => {
		const [ovRes, tRes, pRes] = await Promise.all([
			apiFetch("/api/v1/platform/overview"),
			apiFetch("/api/v1/platform/tenants"),
			apiFetch("/api/v1/platform/plans"),
		]);
		if (ovRes.status === 403) {
			setForbidden(true);
			return;
		}
		if (ovRes.ok) setOverview((await ovRes.json()) as Overview);
		if (tRes.ok) setTenants(((await tRes.json()) as { tenants: TenantRow[] }).tenants);
		if (pRes.ok) setPlans(((await pRes.json()) as { plans: Plan[] }).plans);
	}, []);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reload();
	}, [reload]);

	async function runAction() {
		if (!action) return;
		setPending(true);
		setError(null);
		try {
			const paths: Record<string, { path: string; body?: unknown }> = {
				suspend: { path: "suspend", body: { reason } },
				reactivate: { path: "reactivate" },
				plan: { path: "plan", body: { planKey } },
				trial: { path: "trial-extend", body: { days: Number(days) } },
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
			void reload();
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
				<Button variant="outline" render={<Link href="/" />}>
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
									<TableCell className="space-x-1 text-right">
										{t.status === "suspended" ? (
											<Button
												size="sm"
												variant="outline"
												onClick={() => setAction({ kind: "reactivate", tenant: t })}
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
											</>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</CardContent>
			</Card>

			<Dialog open={action !== null} onOpenChange={(open) => !open && setAction(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{action?.kind === "suspend" && `Suspend ${action.tenant.name}`}
							{action?.kind === "reactivate" && `Reactivate ${action.tenant.name}`}
							{action?.kind === "plan" && `Change plan — ${action?.tenant.name}`}
							{action?.kind === "trial" && `Extend trial — ${action?.tenant.name}`}
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
						{action?.kind === "plan" && (
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
								Cancel
							</Button>
							<Button
								onClick={() => void runAction()}
								disabled={
									pending ||
									(action?.kind === "suspend" && reason.trim().length < 5) ||
									(action?.kind === "plan" && !planKey)
								}
							>
								{pending ? "Working…" : "Confirm"}
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
}: {
	label: string;
	value: number;
	format?: "money";
}) {
	return (
		<Card>
			<CardContent className="p-3">
				<div className="text-xs text-muted-foreground">{label}</div>
				<div className="text-lg font-semibold">
					{format === "money" ? Number(value).toLocaleString() : value}
				</div>
			</CardContent>
		</Card>
	);
}
