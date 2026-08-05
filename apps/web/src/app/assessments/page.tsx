import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import {
	AssessmentsView,
	type AssessmentRow,
	type SubjectRow,
	type TermOption,
	type SectionOption,
} from "./assessments-view";

export const metadata = { title: "Assessments" };

export default async function AssessmentsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];
	const tenantId = tenant.id as string;

	const [{ data: assessments }, { data: sections }, { data: terms }, { data: subjects }] =
		await Promise.all([
			supabase
				.from("assessments")
				.select(
					`id, name, type, status, weight,
					 class_sections(name, grade_levels(name)),
					 academic_terms(name)`,
				)
				.eq("tenant_id", tenantId)
				.order("created_at", { ascending: false })
				.limit(200),
			supabase
				.from("class_sections")
				.select("id, name, grade_levels(name, sequence)")
				.eq("tenant_id", tenantId)
				.eq("status", "active"),
			supabase
				.from("academic_terms")
				.select("id, name, starts_on")
				.eq("tenant_id", tenantId)
				.order("starts_on"),
			supabase
				.from("subjects")
				.select("id, code, name, name_sw, education_level")
				.eq("tenant_id", tenantId)
				.eq("status", "active")
				.order("code"),
		]);

	const sectionOptions: SectionOption[] = (sections ?? [])
		.map((s) => {
			const grade = s.grade_levels as unknown as { name: string; sequence: number } | null;
			return {
				id: s.id,
				label: `${grade?.name ?? "?"} ${s.name}`,
				sequence: grade?.sequence ?? 0,
			};
		})
		.sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label))
		.map(({ id, label }) => ({ id, label }));


	return (
		<AppShell schoolName={tenant.name}>
			<AssessmentsView
				assessments={(assessments ?? []) as unknown as AssessmentRow[]}
				sections={sectionOptions}
				subjects={(subjects ?? []) as unknown as SubjectRow[]}
				tenantId={tenant.id}
				terms={(terms ?? []).map((t) => ({ id: t.id, name: t.name })) as TermOption[]}
			/>
		</AppShell>
	);
}
