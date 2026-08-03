import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { ParentsView, type GuardianRow } from "./parents-view";

export const metadata = { title: "Parents & Guardians" };

export default async function ParentsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	// First page only (50/page) for first paint — the client view re-queries
	// with server-side search + range pagination. Keep the select in sync with
	// GUARDIAN_LIST_SELECT in ./parents-view.tsx.
	const { data: guardians, count } = await supabase
		.from("guardians")
		.select(
			`id, full_name, phone, email, occupation, user_id,
			 student_guardians(relationship, is_primary,
				 students(id, first_name, middle_name, last_name, student_number))`,
			{ count: "exact" },
		)
		.eq("tenant_id", tenant.id)
		.order("full_name")
		.range(0, 49);

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<ParentsView
				guardians={(guardians ?? []) as unknown as GuardianRow[]}
				lang={lang}
				tenantId={tenant.id as string}
				total={count ?? (guardians ?? []).length}
			/>
		</AppShell>
	);
}
