"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BellRingIcon, ChevronDownIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { getDict, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { fmtTZS } from "../finance-view";

interface DebtorRow {
	studentNumber: string;
	studentName: string;
	className: string;
	guardianPhone: string | null;
	invoiceNumber: string;
	total: number;
	paid: number;
	balance: number;
	overdue: number;
}

interface DebtorsClass {
	className: string;
	rows: DebtorRow[];
	subtotal: { balance: number; overdue: number };
}

interface DebtorsPayload {
	asOf: string;
	totals: { outstanding: number; overdue: number };
	classes: DebtorsClass[];
}

function today() {
	return new Date().toISOString().slice(0, 10);
}

export function DebtorsView({ tenantId, lang }: { tenantId: string; lang: Lang }) {
	const t = useMemo(() => getDict(lang), [lang]);
	const [asOf, setAsOf] = useState(today());
	const [data, setData] = useState<DebtorsPayload | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	const reload = useCallback(async () => {
		const res = await apiFetch(
			`/api/v1/finance/debtors?asOf=${encodeURIComponent(asOf)}`,
			{ tenantId },
		);
		setLoading(false);
		if (!res.ok) {
			const body = (await res.json().catch(() => null)) as { code?: string } | null;
			setError(apiErrorMessage(t, body, res.status));
			return;
		}
		setError(null);
		setData((await res.json()) as DebtorsPayload);
	}, [tenantId, asOf, t]);

	useEffect(() => {
		void (async () => {
			await reload();
		})();
	}, [reload]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("finance.debtorsTitle")}</h1>
				<div className="flex items-center gap-2">
					<Input
						aria-label={t("finance.asOf")}
						className="w-40"
						type="date"
						value={asOf}
						onChange={(e) => setAsOf(e.target.value || today())}
					/>
					<SendRemindersButton lang={lang} tenantId={tenantId} />
				</div>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}
			{loading && !data && (
				<p className="py-10 text-center text-sm text-muted-foreground">
					{t("common.loading")}
				</p>
			)}
			{data && data.classes.length === 0 && (
				<Card className="shadow-none">
					<CardContent className="pt-4">
						<p className="py-10 text-center text-sm text-muted-foreground">
							{t("finance.debtorsEmpty")}
						</p>
					</CardContent>
				</Card>
			)}

			{data?.classes.map((cls) => (
				<ClassDebtors cls={cls} key={cls.className} lang={lang} />
			))}

			{data && data.classes.length > 0 && (
				<Card className="shadow-none">
					<CardContent className="flex flex-wrap items-center justify-between gap-2 pt-4 text-sm">
						<span className="font-semibold">{t("finance.grandTotal")}</span>
						<span className="flex gap-6">
							<span>
								{t("finance.balance")}:{" "}
								<span className="font-mono font-medium">
									{fmtTZS(data.totals.outstanding)}
								</span>
							</span>
							<span>
								{t("finance.overdue")}:{" "}
								<span
									className={`font-mono font-medium ${data.totals.overdue > 0 ? "text-down" : ""}`}
								>
									{fmtTZS(data.totals.overdue)}
								</span>
							</span>
						</span>
					</CardContent>
				</Card>
			)}
		</div>
	);
}

function ClassDebtors({ cls, lang }: { cls: DebtorsClass; lang: Lang }) {
	const t = getDict(lang);
	return (
		<Card className="shadow-none">
			<CardContent className="pt-4">
				<Collapsible defaultOpen>
					<CollapsibleTrigger
						render={
							<button
								className="flex w-full items-center justify-between gap-2 text-sm font-semibold"
								type="button"
							/>
						}
					>
						<span>{cls.className}</span>
						<span className="flex items-center gap-4 text-muted-foreground">
							<span className="font-mono">
								{t("finance.classTotal")}: {fmtTZS(cls.subtotal.balance)}
							</span>
							<span
								className={`font-mono ${cls.subtotal.overdue > 0 ? "text-down" : ""}`}
							>
								{t("finance.overdue")}: {fmtTZS(cls.subtotal.overdue)}
							</span>
							<ChevronDownIcon className="size-4" />
						</span>
					</CollapsibleTrigger>
					<CollapsibleContent>
						<Table className="mt-3">
							<TableHeader>
								<TableRow>
									<TableHead>{t("finance.student")}</TableHead>
									<TableHead>{t("finance.invoiceNumber")}</TableHead>
									<TableHead>{t("finance.guardianPhone")}</TableHead>
									<TableHead className="text-right">{t("finance.balance")}</TableHead>
									<TableHead className="text-right">{t("finance.overdue")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{cls.rows.map((row) => (
									<TableRow key={`${row.invoiceNumber}`}>
										<TableCell>
											{row.studentName}{" "}
											<span className="font-mono text-xs text-muted-foreground">
												{row.studentNumber}
											</span>
										</TableCell>
										<TableCell className="font-mono text-xs">
											{row.invoiceNumber}
										</TableCell>
										<TableCell className="font-mono text-xs">
											{row.guardianPhone ?? "—"}
										</TableCell>
										<TableCell className="text-right font-mono">
											{fmtTZS(row.balance)}
										</TableCell>
										<TableCell
											className={`text-right font-mono ${row.overdue > 0 ? "text-down" : ""}`}
										>
											{fmtTZS(row.overdue)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CollapsibleContent>
				</Collapsible>
			</CardContent>
		</Card>
	);
}

function SendRemindersButton({ tenantId, lang }: { tenantId: string; lang: Lang }) {
	const t = getDict(lang);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	async function send() {
		setPending(true);
		setMessage(null);
		try {
			const response = await apiFetch("/api/v1/finance/reminders", {
				method: "POST",
				tenantId,
			});
			const body = (await response.json().catch(() => null)) as {
				queued?: number;
				code?: string;
			} | null;
			setMessage(
				response.ok
					? `${body?.queued ?? 0} ${t("finance.remindersQueued")}`
					: apiErrorMessage(t, body, response.status),
			);
		} catch {
			setMessage(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<span className="flex items-center gap-2">
			{message && <span className="text-sm text-muted-foreground">{message}</span>}
			<Button disabled={pending} onClick={() => void send()} size="sm">
				<BellRingIcon /> {pending ? t("common.loading") : t("finance.sendReminders")}
			</Button>
		</span>
	);
}
