import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
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

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const [{ data: assessments }, { data: sections }, { data: terms }, { data: subjects }] =
		await Promise.all([
			supabase
				.from("assessments")
				.select(
					`id, name, type, status, weight,
					 class_sections(name, grade_levels(name)),
					 academic_terms(name)`,
				)
				.order("created_at", { ascending: false })
				.limit(200),
			supabase
				.from("class_sections")
				.select("id, name, grade_levels(name, sequence)")
				.eq("status", "active"),
			supabase.from("academic_terms").select("id, name, starts_on").order("starts_on"),
			supabase
				.from("subjects")
				.select("id, code, name, name_sw, education_level")
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

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<AssessmentsView
				assessments={(assessments ?? []) as unknown as AssessmentRow[]}
				lang={lang}
				sections={sectionOptions}
				subjects={(subjects ?? []) as unknown as SubjectRow[]}
				tenantId={tenant.id}
				terms={(terms ?? []).map((t) => ({ id: t.id, name: t.name })) as TermOption[]}
			/>
		</AppShell>
	);
}
