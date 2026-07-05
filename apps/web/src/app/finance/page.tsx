import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import {
	FinanceView,
	type FeeItemRow,
	type InvoiceListRow,
	type StudentOption,
	type TermOption,
} from "./finance-view";

export const metadata = { title: "Fees & Payments" };

export default async function FinancePage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const [{ data: invoices }, { data: payments }, { data: feeItems }, { data: students }, { data: terms }] =
		await Promise.all([
			supabase
				.from("invoices")
				.select(
					"id, invoice_number, total, status, issued_on, due_on, students(first_name, last_name, student_number)",
				)
				.order("created_at", { ascending: false })
				.limit(200),
			supabase.from("payments").select("invoice_id, amount"),
			supabase
				.from("fee_items")
				.select("id, name, amount")
				.eq("status", "active")
				.order("name"),
			supabase
				.from("students")
				.select("id, first_name, last_name, student_number")
				.eq("status", "active")
				.order("last_name")
				.limit(500),
			supabase.from("academic_terms").select("id, name").order("starts_on"),
		]);

	const paidByInvoice = new Map<string, number>();
	for (const p of payments ?? []) {
		paidByInvoice.set(
			p.invoice_id,
			(paidByInvoice.get(p.invoice_id) ?? 0) + Number(p.amount),
		);
	}

	const rows: InvoiceListRow[] = (invoices ?? []).map((inv) => {
		const student = inv.students as unknown as {
			first_name: string;
			last_name: string;
			student_number: string;
		} | null;
		const paid = paidByInvoice.get(inv.id) ?? 0;
		return {
			id: inv.id,
			number: inv.invoice_number,
			student: student ? `${student.first_name} ${student.last_name}` : "—",
			studentNumber: student?.student_number ?? "",
			total: Number(inv.total),
			paid,
			status: inv.status,
		};
	});

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<FinanceView
				feeItems={(feeItems ?? []).map((f) => ({
					id: f.id,
					name: f.name,
					amount: Number(f.amount),
				})) as FeeItemRow[]}
				invoices={rows}
				lang={lang}
				students={(students ?? []).map((s) => ({
					id: s.id,
					label: `${s.first_name} ${s.last_name} (${s.student_number})`,
				})) as StudentOption[]}
				tenantId={tenant.id}
				terms={(terms ?? []).map((t) => ({ id: t.id, name: t.name })) as TermOption[]}
			/>
		</AppShell>
	);
}
