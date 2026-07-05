"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PlusIcon, ReceiptIcon } from "lucide-react";
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

export interface InvoiceListRow {
	id: string;
	number: string;
	student: string;
	studentNumber: string;
	total: number;
	paid: number;
	status: string;
}

export interface FeeItemRow {
	id: string;
	name: string;
	amount: number;
}

export interface StudentOption {
	id: string;
	label: string;
}

export interface TermOption {
	id: string;
	name: string;
}

export function fmtTZS(amount: number) {
	return `${amount.toLocaleString("en-US")} TZS`;
}

export function statusVariant(status: string): "default" | "secondary" | "outline" {
	if (status === "paid") return "default";
	if (status === "partially_paid") return "secondary";
	return "outline";
}

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function FinanceView({
	tenantId,
	invoices,
	feeItems,
	students,
	terms,
	lang,
}: {
	tenantId: string;
	invoices: InvoiceListRow[];
	feeItems: FeeItemRow[];
	students: StudentOption[];
	terms: TermOption[];
	lang: Lang;
}) {
	const t = getDict(lang);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("finance.title")}</h1>
				<div className="flex gap-2">
					<FeeItemsDialog feeItems={feeItems} lang={lang} tenantId={tenantId} />
					<CreateInvoiceDialog
						feeItems={feeItems}
						lang={lang}
						students={students}
						tenantId={tenantId}
						terms={terms}
					/>
				</div>
			</div>

			<Card className="shadow-none">
				<CardContent className="pt-4">
					{invoices.length === 0 ? (
						<p className="py-10 text-center text-sm text-muted-foreground">
							{t("finance.empty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("finance.invoiceNumber")}</TableHead>
									<TableHead>{t("finance.student")}</TableHead>
									<TableHead className="text-right">{t("finance.total")}</TableHead>
									<TableHead className="text-right">{t("finance.paid")}</TableHead>
									<TableHead className="text-right">{t("finance.balance")}</TableHead>
									<TableHead>{t("students.status")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{invoices.map((inv) => (
									<TableRow key={inv.id}>
										<TableCell>
											<Link
												className="font-mono text-xs font-medium text-primary hover:underline"
												href={`/finance/${inv.id}`}
											>
												{inv.number}
											</Link>
										</TableCell>
										<TableCell>
											{inv.student}{" "}
											<span className="font-mono text-xs text-muted-foreground">
												{inv.studentNumber}
											</span>
										</TableCell>
										<TableCell className="text-right">{fmtTZS(inv.total)}</TableCell>
										<TableCell className="text-right">{fmtTZS(inv.paid)}</TableCell>
										<TableCell className="text-right font-medium">
											{fmtTZS(inv.total - inv.paid)}
										</TableCell>
										<TableCell>
											<Badge variant={statusVariant(inv.status)}>
												{t(`finance.status.${inv.status}` as DictKey)}
											</Badge>
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

function FeeItemsDialog({
	tenantId,
	feeItems,
	lang,
}: {
	tenantId: string;
	feeItems: FeeItemRow[];
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [amount, setAmount] = useState("");

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setPending(true);
		setError(null);
		const response = await apiFetch("/api/v1/finance/fee-items", {
			method: "POST",
			tenantId,
			body: JSON.stringify({ name, amount: Number(amount) }),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		setName("");
		setAmount("");
		router.refresh();
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				<ReceiptIcon /> {t("finance.feeItems")}
			</DialogTrigger>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("finance.feeItems")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					{feeItems.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("finance.feeItemsEmpty")}</p>
					) : (
						<div className="max-h-48 overflow-y-auto rounded-md border">
							<Table>
								<TableBody>
									{feeItems.map((f) => (
										<TableRow key={f.id}>
											<TableCell>{f.name}</TableCell>
											<TableCell className="text-right">{fmtTZS(f.amount)}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					)}
					<form className="flex flex-col gap-2" onSubmit={submit}>
						<Input
							placeholder={t("finance.description")}
							required
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
						<Input
							min={1}
							placeholder={t("finance.amount")}
							required
							type="number"
							value={amount}
							onChange={(e) => setAmount(e.target.value)}
						/>
						{error && <p className="text-sm text-destructive">{error}</p>}
						<div className="flex justify-end">
							<Button disabled={pending} size="sm" type="submit">
								{pending ? t("common.loading") : t("finance.newFeeItem")}
							</Button>
						</div>
					</form>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function CreateInvoiceDialog({
	tenantId,
	feeItems,
	students,
	terms,
	lang,
}: {
	tenantId: string;
	feeItems: FeeItemRow[];
	students: StudentOption[];
	terms: TermOption[];
	lang: Lang;
}) {
	const t = getDict(lang);
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [studentId, setStudentId] = useState("");
	const [termId, setTermId] = useState("");
	const [dueOn, setDueOn] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [customDesc, setCustomDesc] = useState("");
	const [customAmount, setCustomAmount] = useState("");

	function toggle(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	const total =
		feeItems.filter((f) => selected.has(f.id)).reduce((sum, f) => sum + f.amount, 0) +
		(customDesc && customAmount ? Number(customAmount) || 0 : 0);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		const lines: Array<Record<string, unknown>> = [
			...[...selected].map((feeItemId) => ({ feeItemId })),
			...(customDesc && customAmount
				? [{ description: customDesc, amount: Number(customAmount) }]
				: []),
		];
		if (lines.length === 0 || !studentId) return;
		setPending(true);
		setError(null);
		const response = await apiFetch("/api/v1/finance/invoices", {
			method: "POST",
			tenantId,
			body: JSON.stringify({
				studentId,
				academicTermId: termId || undefined,
				dueOn: dueOn || undefined,
				lines,
			}),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		const body = await response.json();
		setOpen(false);
		router.push(`/finance/${body.invoiceId}`);
	}

	return (
		<Dialog onOpenChange={setOpen} open={open}>
			<DialogTrigger render={<Button size="sm" />}>
				<PlusIcon /> {t("finance.newInvoice")}
			</DialogTrigger>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("finance.newInvoice")}</DialogTitle>
				</DialogHeader>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<select
						className={selectClass}
						onChange={(e) => setStudentId(e.target.value)}
						required
						value={studentId}
					>
						<option value="">{t("finance.student")} —</option>
						{students.map((s) => (
							<option key={s.id} value={s.id}>
								{s.label}
							</option>
						))}
					</select>
					<div className="grid grid-cols-2 gap-2">
						<select
							className={selectClass}
							onChange={(e) => setTermId(e.target.value)}
							value={termId}
						>
							<option value="">{t("assessments.term")} —</option>
							{terms.map((term) => (
								<option key={term.id} value={term.id}>
									{term.name}
								</option>
							))}
						</select>
						<Input
							aria-label={t("finance.dueOn")}
							type="date"
							value={dueOn}
							onChange={(e) => setDueOn(e.target.value)}
						/>
					</div>

					{feeItems.length > 0 && (
						<div className="max-h-40 overflow-y-auto rounded-md border p-2">
							{feeItems.map((f) => (
								<label className="flex items-center gap-2 py-1 text-sm" key={f.id}>
									<input
										checked={selected.has(f.id)}
										onChange={() => toggle(f.id)}
										type="checkbox"
									/>
									<span className="flex-1">{f.name}</span>
									<span className="text-muted-foreground">{fmtTZS(f.amount)}</span>
								</label>
							))}
						</div>
					)}

					<div className="grid grid-cols-2 gap-2">
						<Input
							placeholder={t("finance.customLine")}
							value={customDesc}
							onChange={(e) => setCustomDesc(e.target.value)}
						/>
						<Input
							min={1}
							placeholder={t("finance.amount")}
							type="number"
							value={customAmount}
							onChange={(e) => setCustomAmount(e.target.value)}
						/>
					</div>

					<p className="text-right text-sm font-medium">
						{t("finance.total")}: {fmtTZS(total)}
					</p>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end gap-2">
						<Button onClick={() => setOpen(false)} type="button" variant="outline">
							{t("common.cancel")}
						</Button>
						<Button disabled={pending || total <= 0 || !studentId} type="submit">
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
