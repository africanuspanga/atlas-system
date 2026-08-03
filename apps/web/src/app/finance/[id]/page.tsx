import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { todayInTanzania } from "@/lib/tanzania-date";
import { InvoiceView, type InvoiceDetail } from "./invoice-view";

export const metadata = { title: "Invoice" };

export default async function InvoicePage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];
	const tenantId = tenant.id as string;

	const { data: invoice } = await supabase
		.from("invoices")
		.select(
			`id, invoice_number, total, status, issued_on, due_on,
			 students(first_name, last_name, student_number),
			 invoice_lines(id, description, amount),
			 invoice_instalments(id, seq, amount, due_on),
			 payments(id, receipt_number, amount, method, reference, note, paid_on, reverses_payment_id)`,
		)
		.eq("id", id)
		.eq("tenant_id", tenantId)
		.maybeSingle();
	if (!invoice) notFound();

	const student = invoice.students as unknown as {
		first_name: string;
		last_name: string;
		student_number: string;
	} | null;
	const payments = (invoice.payments ?? []) as unknown as Array<{
		id: string;
		receipt_number: string;
		amount: number;
		method: string;
		reference: string | null;
		note: string | null;
		paid_on: string;
		reverses_payment_id: string | null;
	}>;
	const reversedIds = new Set(
		payments.map((p) => p.reverses_payment_id).filter(Boolean) as string[],
	);
	const paid = payments.reduce((sum, p) => sum + Number(p.amount), 0);

	// Paid-so-far waterfalls across the instalment plan by seq (display only;
	// payments stay on the invoice).
	const today = todayInTanzania();
	const sortedPlan = ((invoice.invoice_instalments ?? []) as unknown as Array<{
		id: string;
		seq: number;
		amount: number;
		due_on: string;
	}>).toSorted((a, b) => a.seq - b.seq);
	const covered = sortedPlan.map((row, index) => {
		const before = sortedPlan
			.slice(0, index)
			.reduce((sum, r) => sum + Number(r.amount), 0);
		return Math.min(Math.max(paid - before, 0), Number(row.amount));
	});
	const dueIndex = sortedPlan.findIndex(
		(row, index) => covered[index] < Number(row.amount) && row.due_on >= today,
	);
	const instalments = sortedPlan.map((row, index) => {
		const amount = Number(row.amount);
		const rowPaid = covered[index];
		const state: "paid" | "overdue" | "due" | "upcoming" =
			rowPaid >= amount
				? "paid"
				: row.due_on < today
					? "overdue"
					: index === dueIndex
						? "due"
						: "upcoming";
		return {
			id: row.id,
			seq: row.seq,
			amount,
			dueOn: row.due_on,
			paid: rowPaid,
			state,
		};
	});

	const detail: InvoiceDetail = {
		id: invoice.id,
		number: invoice.invoice_number,
		status: invoice.status,
		total: Number(invoice.total),
		paid,
		issuedOn: invoice.issued_on,
		dueOn: invoice.due_on,
		student: student
			? `${student.first_name} ${student.last_name} (${student.student_number})`
			: "—",
		lines: ((invoice.invoice_lines ?? []) as unknown as Array<{
			id: string;
			description: string;
			amount: number;
		}>).map((l) => ({ id: l.id, description: l.description, amount: Number(l.amount) })),
		instalments,
		payments: payments
			.sort((a, b) => a.receipt_number.localeCompare(b.receipt_number))
			.map((p) => ({
				id: p.id,
				receipt: p.receipt_number,
				amount: Number(p.amount),
				method: p.method,
				reference: p.reference,
				note: p.note,
				paidOn: p.paid_on,
				isReversal: p.reverses_payment_id !== null,
				isReversed: reversedIds.has(p.id),
			})),
	};

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<InvoiceView invoice={detail} lang={lang} tenantId={tenant.id} />
		</AppShell>
	);
}
