import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import { StudentsView, type SectionOption, type StudentListRow } from "./students-view";

export const metadata = { title: "Students" };

const MANAGE_SUPER_ROLES = ["school_owner", "director"];

export default async function StudentsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];
	const tenantId = tenant.id as string;

	// First page only (50/page) for first paint — the client view re-queries
	// with server-side search + range pagination. Keep the select in sync with
	// STUDENT_LIST_SELECT in ./students-view.tsx.
	const [{ data: students, count }, { data: sections }, { data: memberships }] =
		await Promise.all([
			supabase
				.from("students")
				.select(
					`id, student_number, first_name, middle_name, last_name, status,
					 class_enrolments(id, status, academic_year_id,
						 class_sections(id, name, grade_levels(name))),
					 student_guardians(is_primary, guardians(id, full_name, phone, email, user_id))`,
					{ count: "exact" },
				)
				.eq("tenant_id", tenantId)
				.order("created_at", { ascending: false })
				.range(0, 49),
			// Only active sections are placeable — app.set_class_enrolment rejects
			// anything else with ENROLMENT_SECTION_NOT_FOUND.
			supabase
				.from("class_sections")
				.select(
					"id, name, academic_year_id, grade_levels(name, sequence), academic_years(name, starts_on)",
				)
				.eq("tenant_id", tenantId)
				.eq("status", "active")
				.order("name")
				.limit(1000),
			supabase
				.from("tenant_memberships")
				.select("id, membership_roles(roles(id, key))")
				.eq("tenant_id", tenantId)
				.eq("user_id", user.id)
				.eq("status", "active"),
		]);

	// Lifecycle rights: owner/director are superusers; otherwise the member needs
	// a role carrying the key (simple RLS read — the API re-checks every write).
	const roles = (memberships ?? []).flatMap((m) =>
		(m.membership_roles ?? []).map(
			(r) => r.roles as unknown as { id: string; key: string } | null,
		),
	);
	const isSuper = roles.some((r) => r && MANAGE_SUPER_ROLES.includes(r.key));
	let canUpdate = isSuper;
	let canArchive = isSuper;
	if (!isSuper && roles.length > 0) {
		const { data: perms } = await supabase
			.from("role_permissions")
			.select("permission_key")
			.in(
				"role_id",
				roles.filter((r) => r !== null).map((r) => r.id),
			)
			.in("permission_key", ["students.update", "students.archive"]);
		const keys = new Set((perms ?? []).map((p) => p.permission_key as string));
		canUpdate = keys.has("students.update");
		canArchive = keys.has("students.archive");
	}


	// Newest year first, then grade order, then stream label — the same reading
	// order the class-placement picker groups by.
	const sectionOptions: SectionOption[] = (sections ?? [])
		.map((s) => {
			const grade = s.grade_levels as unknown as { name: string; sequence: number } | null;
			const year = s.academic_years as unknown as {
				name: string;
				starts_on: string;
			} | null;
			return {
				id: s.id as string,
				label: `${grade?.name ?? "?"} ${s.name}`,
				gradeSequence: grade?.sequence ?? 99,
				academicYearId: s.academic_year_id as string,
				yearName: year?.name ?? "—",
				yearStartsOn: year?.starts_on ?? "",
			};
		})
		.sort(
			(a, b) =>
				b.yearStartsOn.localeCompare(a.yearStartsOn) ||
				a.gradeSequence - b.gradeSequence ||
				a.label.localeCompare(b.label),
		);

	return (
		<AppShell schoolName={tenant.name}>
			<StudentsView
				canArchive={canArchive}
				canUpdate={canUpdate}
				sections={sectionOptions}
				students={(students ?? []) as unknown as StudentListRow[]}
				tenantId={tenant.id}
				total={count ?? (students ?? []).length}
			/>
		</AppShell>
	);
}
