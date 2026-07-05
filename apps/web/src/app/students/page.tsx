import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { StudentsView, type SectionOption, type StudentListRow } from "./students-view";

export const metadata = { title: "Students" };

export default async function StudentsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const [{ data: students }, { data: sections }] = await Promise.all([
		supabase
			.from("students")
			.select(
				`id, student_number, first_name, middle_name, last_name, status,
				 class_enrolments(class_sections(name, grade_levels(name))),
				 student_guardians(is_primary, guardians(full_name, phone))`,
			)
			.order("created_at", { ascending: false })
			.limit(300),
		supabase
			.from("class_sections")
			.select("id, name, grade_levels(name)")
			.order("name"),
	]);

	const { lang } = await getServerDict();

	const sectionOptions: SectionOption[] = (sections ?? []).map((s) => ({
		id: s.id,
		label: `${(s.grade_levels as unknown as { name: string } | null)?.name ?? "?"} ${s.name}`,
	}));

	return (
		<AppShell schoolName={tenant.name}>
			<StudentsView
				lang={lang}
				sections={sectionOptions}
				students={(students ?? []) as unknown as StudentListRow[]}
				tenantId={tenant.id}
			/>
		</AppShell>
	);
}
