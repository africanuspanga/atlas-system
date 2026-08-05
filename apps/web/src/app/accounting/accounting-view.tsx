"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { getDict, type DictKey } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ListSkeleton } from "@/components/list-skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

interface TrialBalanceRow {
	code: string;
	name: string;
	type: string;
	debits: number;
	credits: number;
	balance: number;
}

interface TrialBalance {
	rows: TrialBalanceRow[];
	totals: { debits: number; credits: number };
	generatedAt: string;
}

function fmt(amount: number) {
	return amount === 0 ? "—" : amount.toLocaleString("en-US");
}

/**
 * Trial balance fetched from the ledger-reconciled report RPC via the API —
 * never computed in the web tier (row caps would silently corrupt it).
 */
export function TrialBalanceCard({
	tenantId,
}: {
	tenantId: string;
}) {
	const t = getDict();
	const [report, setReport] = useState<TrialBalance | null>(null);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setLoaded(false);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/finance/trial-balance", {
				tenantId,
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setReport((await response.json()) as TrialBalance);
		} catch {
			setError(t("common.apiUnreachable"));
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
		<Card className="shadow-none">
			<CardHeader className="flex flex-row items-center justify-between gap-2">
				<CardTitle className="text-base">{t("acct.trialBalance")}</CardTitle>
				{report && (
					<span className="text-xs text-muted-foreground">
						{t("acct.asOf")}{" "}
						<span className="font-mono">
							{new Date(report.generatedAt).toLocaleString()}
						</span>
					</span>
				)}
			</CardHeader>
			<CardContent>
				{!loaded ? (
					<ListSkeleton className="border-0 p-0" />
				) : error ? (
					<div className="flex flex-col items-center gap-3 py-6">
						<p className="text-center text-sm text-destructive">{error}</p>
						<Button onClick={() => void reload()} size="sm" variant="outline">
							{t("common.retry")}
						</Button>
					</div>
				) : !report || report.rows.length === 0 ? (
					<p className="py-6 text-center text-sm text-muted-foreground">
						{t("acct.tbEmpty")}
					</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t("acct.account")}</TableHead>
								<TableHead>{t("acct.type")}</TableHead>
								<TableHead className="text-right">{t("acct.debit")}</TableHead>
								<TableHead className="text-right">{t("acct.credit")}</TableHead>
								<TableHead className="text-right">{t("finance.balance")}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{report.rows.map((row) => (
								<TableRow key={row.code}>
									<TableCell>
										<span className="font-mono text-xs">{row.code}</span> {row.name}
									</TableCell>
									<TableCell>
										<Badge variant="outline">
											{t(`acct.type.${row.type}` as DictKey)}
										</Badge>
									</TableCell>
									<TableCell className="text-right font-mono tabular-nums">
										{fmt(Number(row.debits))}
									</TableCell>
									<TableCell className="text-right font-mono tabular-nums">
										{fmt(Number(row.credits))}
									</TableCell>
									<TableCell className="text-right font-mono font-medium tabular-nums">
										{fmt(Number(row.balance))}
									</TableCell>
								</TableRow>
							))}
							<TableRow>
								<TableCell className="font-semibold" colSpan={2}>
									{t("finance.total")}
								</TableCell>
								<TableCell className="text-right font-mono font-semibold tabular-nums">
									{fmt(Number(report.totals.debits))}
								</TableCell>
								<TableCell className="text-right font-mono font-semibold tabular-nums">
									{fmt(Number(report.totals.credits))}
								</TableCell>
								<TableCell />
							</TableRow>
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
}
