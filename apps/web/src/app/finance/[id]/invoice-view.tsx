"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BanknoteIcon, Undo2Icon } from "lucide-react";
import { apiFetch } from "@/lib/api";
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

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		const response = await apiFetch(`/api/v1/finance/invoices/${invoiceId}/payments`, {
			method: "POST",
			tenantId,
			body: JSON.stringify({
				amount: Number(amount),
				method,
				reference: reference || undefined,
			}),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		setOpen(false);
		router.refresh();
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
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
		const response = await apiFetch(`/api/v1/finance/payments/${paymentId}/reverse`, {
			method: "POST",
			tenantId,
			body: JSON.stringify({ reason }),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		setOpen(false);
		router.refresh();
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
