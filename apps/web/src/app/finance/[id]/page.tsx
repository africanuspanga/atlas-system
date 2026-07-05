import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
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

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const { data: invoice } = await supabase
		.from("invoices")
		.select(
			`id, invoice_number, total, status, issued_on, due_on,
			 students(first_name, last_name, student_number),
			 invoice_lines(id, description, amount),
			 payments(id, receipt_number, amount, method, reference, note, paid_on, reverses_payment_id)`,
		)
		.eq("id", id)
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
