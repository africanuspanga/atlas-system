import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { AdmissionsView, type AdmissionRow } from "./admissions-view";

export const metadata = { title: "Admissions" };

export default async function AdmissionsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase
		.from("tenants")
		.select("id, name")
		.order("created_at", { ascending: true })
		.limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	// Read-only overview via RLS; explicit tenant filter on top. The exact
	// count survives the 1000-row read cap.
	const { data: students, count } = await supabase
		.from("students")
		.select(
			`id, student_number, first_name, middle_name, last_name, status,
			 admission_date, created_at,
			 class_enrolments(class_sections(name, grade_levels(name, sequence)))`,
			{ count: "exact" },
		)
		.eq("tenant_id", tenant.id)
		.order("created_at", { ascending: false })
		.range(0, 999);

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<AdmissionsView
				lang={lang}
				students={(students ?? []) as unknown as AdmissionRow[]}
				tenantId={tenant.id as string}
				total={count ?? (students ?? []).length}
			/>
		</AppShell>
	);
}
