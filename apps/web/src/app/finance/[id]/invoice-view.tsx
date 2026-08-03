"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BanknoteIcon, CalendarRangeIcon, Undo2Icon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { getDict, type Lang, type DictKey } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { fmtTZS, statusVariant } from "../finance-view";

export interface InstalmentRow {
	id: string;
	seq: number;
	amount: number;
	dueOn: string;
	paid: number;
	state: "paid" | "overdue" | "due" | "upcoming";
}

export interface InvoiceDetail {
	id: string;
	number: string;
	status: string;
	total: number;
	paid: number;
	issuedOn: string;
	dueOn: string | null;
	student: string;
	lines: Array<{ id: string; description: string; amount: number }>;
	instalments: InstalmentRow[];
	payments: Array<{
		id: string;
		receipt: string;
		amount: number;
		method: string;
		reference: string | null;
		note: string | null;
		paidOn: string;
		isReversal: boolean;
		isReversed: boolean;
	}>;
}

const METHODS = [
	"cash",
	"mpesa",
	"tigopesa",
	"airtel_money",
	"halopesa",
	"bank",
	"cheque",
	"other",
] as const;

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

function instalmentStateVariant(
	state: InstalmentRow["state"],
): "default" | "secondary" | "outline" {
	if (state === "paid") return "default";
	if (state === "due") return "secondary";
	return "outline";
}

export function InvoiceView({
	tenantId,
	invoice,
	lang,
}: {
	tenantId: string;
	invoice: InvoiceDetail;
	lang: Lang;
}) {
	const t = getDict(lang);
	const balance = invoice.total - invoice.paid;

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h1 className="font-mono text-xl font-semibold">{invoice.number}</h1>
					<p className="text-sm text-muted-foreground">{invoice.student}</p>
				</div>
				<div className="flex items-center gap-2">
					<Badge variant={statusVariant(invoice.status)}>
						{t(`finance.status.${invoice.status}` as DictKey)}
					</Badge>
					{balance > 0 && (
						<RecordPaymentDialog
							balance={balance}
							invoiceId={invoice.id}
							lang={lang}
							tenantId={tenantId}
						/>
					)}
				</div>
			</div>

			<Card className="shadow-none">
				<CardContent className="flex flex-col gap-4 pt-4">
					<Table>
						<TableBody>
							{invoice.lines.map((line) => (
								<TableRow key={line.id}>
									<TableCell>{line.description}</TableCell>
									<TableCell className="text-right">{fmtTZS(line.amount)}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
					<div className="grid grid-cols-3 gap-2 rounded-md border p-3 text-sm">
						<div>
							<p className="text-muted-foreground">{t("finance.total")}</p>
							<p className="font-semibold">{fmtTZS(invoice.total)}</p>
						</div>
						<div>
							<p className="text-muted-foreground">{t("finance.paid")}</p>
							<p className="font-semibold">{fmtTZS(invoice.paid)}</p>
						</div>
						<div>
							<p className="text-muted-foreground">{t("finance.balance")}</p>
							<p className="font-semibold">{fmtTZS(balance)}</p>
						</div>
					</div>
				</CardContent>
			</Card>

			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-base font-semibold">{t("finance.instalments")}</h2>
				{invoice.status !== "paid" && (
					<SetInstalmentsDialog
						instalments={invoice.instalments}
						invoiceId={invoice.id}
						lang={lang}
						tenantId={tenantId}
						total={invoice.total}
					/>
				)}
			</div>
			<Card className="shadow-none">
				<CardContent className="pt-4">
					{invoice.instalments.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("finance.instalmentsEmpty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("finance.instalment")}</TableHead>
									<TableHead>{t("finance.dueOn")}</TableHead>
									<TableHead className="text-right">{t("finance.amount")}</TableHead>
									<TableHead className="text-right">{t("finance.paid")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{invoice.instalments.map((row) => (
									<TableRow key={row.id}>
										<TableCell className="font-mono text-xs">{row.seq}</TableCell>
										<TableCell>{row.dueOn}</TableCell>
										<TableCell className="text-right font-mono">
											{fmtTZS(row.amount)}
										</TableCell>
										<TableCell className="text-right font-mono">
											{fmtTZS(row.paid)}
										</TableCell>
										<TableCell>
											<Badge
												className={row.state === "overdue" ? "text-down" : undefined}
												variant={instalmentStateVariant(row.state)}
											>
												{t(`finance.state.${row.state}` as DictKey)}
											</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<h2 className="text-base font-semibold">{t("finance.payments")}</h2>
			<Card className="shadow-none">
				<CardContent className="pt-4">
					{invoice.payments.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">—</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("finance.receipt")}</TableHead>
									<TableHead>{t("finance.date")}</TableHead>
									<TableHead>{t("finance.method")}</TableHead>
									<TableHead className="text-right">{t("finance.amount")}</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{invoice.payments.map((p) => (
									<TableRow key={p.id}>
										<TableCell className="font-mono text-xs">
											{p.receipt}
											{p.isReversal && (
												<span className="ml-1 text-muted-foreground">
													({t("finance.reversalOf").toLowerCase()})
												</span>
											)}
										</TableCell>
										<TableCell>{p.paidOn}</TableCell>
										<TableCell>
											{t(`finance.method.${p.method}` as DictKey)}
											{p.reference && (
												<span className="ml-1 font-mono text-xs text-muted-foreground">
													{p.reference}
												</span>
											)}
										</TableCell>
										<TableCell
											className={`text-right ${p.amount < 0 ? "text-destructive" : ""}`}
										>
											{fmtTZS(p.amount)}
										</TableCell>
										<TableCell className="text-right">
											{!p.isReversal && !p.isReversed && (
												<ReverseDialog
													lang={lang}
													paymentId={p.id}
													receipt={p.receipt}
													tenantId={tenantId}
												/>
											)}
											{p.isReversed && (
												<Badge variant="outline">{t("finance.reversed")}</Badge>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

function RecordPaymentDialog({
	tenantId,
	invoiceId,
	balance,
	lang,
}: {
	tenantId: string;
	invoiceId: string;
	balance: number;
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [amount, setAmount] = useState(String(balance));
	const [method, setMethod] = useState("mpesa");
	const [reference, setReference] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/finance/invoices/${invoiceId}/payments`, {
				method: "POST",
				tenantId,
					body: JSON.stringify({
						idempotencyKey,
						amount: Number(amount),
					method,
					reference: reference || undefined,
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setOpen(false);
			router.refresh();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog
			onOpenChange={(next) => {
				setOpen(next);
				if (next) setIdempotencyKey(crypto.randomUUID());
			}}
			open={open}
		>
			<DialogTrigger render={<Button size="sm" />}>
				<BanknoteIcon /> {t("finance.recordPayment")}
			</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("finance.recordPayment")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<Input
						max={balance}
						min={1}
						placeholder={t("finance.amount")}
						required
						type="number"
						value={amount}
						onChange={(e) => setAmount(e.target.value)}
					/>
					<select
						className={selectClass}
						onChange={(e) => setMethod(e.target.value)}
						value={method}
					>
						{METHODS.map((m) => (
							<option key={m} value={m}>
								{t(`finance.method.${m}` as DictKey)}
							</option>
						))}
					</select>
					<Input
						placeholder={t("finance.reference")}
						value={reference}
						onChange={(e) => setReference(e.target.value)}
					/>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button onClick={() => setOpen(false)} type="button" variant="outline">
							{t("common.cancel")}
						</Button>
						<Button disabled={pending} type="submit">
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function SetInstalmentsDialog({
	tenantId,
	invoiceId,
	total,
	instalments,
	lang,
}: {
	tenantId: string;
	invoiceId: string;
	total: number;
	instalments: InstalmentRow[];
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [rows, setRows] = useState<Array<{ amount: string; dueOn: string }>>(
		instalments.length > 0
			? instalments.map((i) => ({ amount: String(i.amount), dueOn: i.dueOn }))
			: [{ amount: String(total), dueOn: "" }],
	);

	const allocated = rows.reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
	const remaining = total - allocated;

	function setRow(index: number, patch: Partial<{ amount: string; dueOn: string }>) {
		setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		if (remaining !== 0) {
			setError(t("finance.instalmentsMustSum"));
			return;
		}
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/finance/invoices/${invoiceId}/instalments`, {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					rows: rows.map((r) => ({ amount: Number(r.amount), dueOn: r.dueOn })),
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setOpen(false);
			router.refresh();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				<CalendarRangeIcon /> {t("finance.setInstalments")}
			</DialogTrigger>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("finance.setInstalments")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					{rows.map((row, index) => (
						// Rows are positional (seq 1..n) — index is the identity here.
						<div className="flex items-center gap-2" key={index}>
							<span className="w-5 text-right font-mono text-xs text-muted-foreground">
								{index + 1}
							</span>
							<Input
								aria-label={t("finance.amount")}
								min={1}
								placeholder={t("finance.amount")}
								required
								type="number"
								value={row.amount}
								onChange={(e) => setRow(index, { amount: e.target.value })}
							/>
							<Input
								aria-label={t("finance.dueOn")}
								required
								type="date"
								value={row.dueOn}
								onChange={(e) => setRow(index, { dueOn: e.target.value })}
							/>
							{rows.length > 1 && (
								<Button
									aria-label={t("finance.removeInstalment")}
									onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
									size="sm"
									type="button"
									variant="ghost"
								>
									×
								</Button>
							)}
						</div>
					))}
					{rows.length < 6 && (
						<Button
							onClick={() => setRows((prev) => [...prev, { amount: "", dueOn: "" }])}
							size="sm"
							type="button"
							variant="outline"
						>
							{t("finance.addInstalment")}
						</Button>
					)}
					<p className="text-right text-sm">
						{t("finance.remainingToAllocate")}:{" "}
						<span className={`font-mono ${remaining !== 0 ? "text-down" : "text-up"}`}>
							{fmtTZS(remaining)}
						</span>
					</p>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button onClick={() => setOpen(false)} type="button" variant="outline">
							{t("common.cancel")}
						</Button>
						<Button disabled={pending || remaining !== 0} type="submit">
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}

function ReverseDialog({
	tenantId,
	paymentId,
	receipt,
	lang,
}: {
	tenantId: string;
	paymentId: string;
	receipt: string;
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [reason, setReason] = useState("");

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/finance/payments/${paymentId}/reverse`, {
				method: "POST",
				tenantId,
				body: JSON.stringify({ reason }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setOpen(false);
			router.refresh();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger
				render={<Button size="sm" variant="ghost" />}
			>
				<Undo2Icon /> {t("finance.reverse")}
			</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t("finance.reversalOf")} {receipt}
					</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<Input
						minLength={3}
						placeholder={t("finance.reverseReason")}
						required
						value={reason}
						onChange={(e) => setReason(e.target.value)}
					/>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button onClick={() => setOpen(false)} type="button" variant="outline">
							{t("common.cancel")}
						</Button>
						<Button disabled={pending} type="submit" variant="destructive">
							{pending ? t("common.loading") : t("finance.reverse")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
