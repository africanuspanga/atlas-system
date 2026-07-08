import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { ReportsView } from "./reports-view";

export const metadata = { title: "Reports" };

export default async function ReportsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenantId = tenants[0].id;

	// Students + terms for the per-student report parameters (RLS reads).
	const [{ data: students }, { data: terms }] = await Promise.all([
		supabase
			.from("students")
			.select("id, student_number, first_name, last_name")
			.eq("tenant_id", tenantId)
			.eq("status", "active")
			.order("last_name")
			.limit(1000),
		supabase
			.from("academic_terms")
			.select("id, name")
			.eq("tenant_id", tenantId)
			.order("starts_on", { ascending: false })
			.limit(12),
	]);
	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenants[0].name}>
			<ReportsView
				lang={lang}
				tenantId={tenantId}
				students={(students ?? []).map((s) => ({
					id: s.id,
					label: `${s.first_name} ${s.last_name} (${s.student_number})`,
				}))}
				terms={terms ?? []}
			/>
		</AppShell>
	);
}
