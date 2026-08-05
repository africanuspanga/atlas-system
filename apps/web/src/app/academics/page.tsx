import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import {
	AcademicsView,
	type GradeLevelRow,
	type SectionRow,
	type SubjectRow,
	type YearRow,
} from "./academics-view";

export const metadata = { title: "Academics" };

const MANAGE_SUPER_ROLES = ["school_owner", "director"];

export default async function AcademicsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	// Simple reads via RLS ("members read" policies); explicit tenant filter on
	// top of RLS per house rules. Writes (combinations, CA, exports) go through
	// the API from the client view.
	const [
		{ data: subjects },
		{ data: gradeLevels },
		{ data: sections },
		{ data: years },
		{ data: memberships },
	] = await Promise.all([
		supabase
			.from("subjects")
			.select("id, code, name, name_sw, education_level, status")
			.eq("tenant_id", tenant.id)
			.order("education_level")
			.order("code")
			.limit(500),
		supabase
			.from("grade_levels")
			.select("id, name, education_level, sequence")
			.eq("tenant_id", tenant.id)
			.order("sequence")
			.limit(200),
		supabase
			.from("class_sections")
			.select(
				`id, name, capacity, status, academic_year_id,
				 grade_levels(name, sequence, education_level),
				 academic_years(name, starts_on),
				 class_enrolments(count)`,
			)
			.eq("tenant_id", tenant.id)
			.order("name")
			.limit(500),
		supabase
			.from("academic_years")
			.select(
				"id, name, starts_on, ends_on, status, academic_terms(id, name, sequence, starts_on, ends_on)",
			)
			.eq("tenant_id", tenant.id)
			.order("starts_on", { ascending: false })
			.limit(50),
		supabase
			.from("tenant_memberships")
			.select("id, membership_roles(roles(id, key))")
			.eq("tenant_id", tenant.id)
			.eq("user_id", user.id)
			.eq("status", "active"),
	]);

	// Manage rights: owner/director are superusers; otherwise the member needs
	// a role carrying the key (simple RLS read — the API re-checks anyway).
	const roles = (memberships ?? []).flatMap((m) =>
		(m.membership_roles ?? []).map(
			(r) => r.roles as unknown as { id: string; key: string } | null,
		),
	);
	const isSuper = roles.some((r) => r && MANAGE_SUPER_ROLES.includes(r.key));
	let canManageCombinations = isSuper;
	// academics.manage covers both the NECTA candidate export and the year /
	// grade / stream writers added in migration 0030.
	let canManageAcademics = isSuper;
	if (!isSuper && roles.length > 0) {
		const { data: perms } = await supabase
			.from("role_permissions")
			.select("permission_key")
			.in(
				"role_id",
				roles.filter((r) => r !== null).map((r) => r.id),
			)
			.in("permission_key", ["academics.combinations.manage", "academics.manage"]);
		const keys = new Set((perms ?? []).map((p) => p.permission_key as string));
		canManageCombinations = keys.has("academics.combinations.manage");
		canManageAcademics = keys.has("academics.manage");
	}


	return (
		<AppShell schoolName={tenant.name}>
			<AcademicsView
				canExport={canManageAcademics}
				canManage={canManageAcademics}
				canManageCombinations={canManageCombinations}
				gradeLevels={(gradeLevels ?? []) as unknown as GradeLevelRow[]}
				sections={(sections ?? []) as unknown as SectionRow[]}
				subjects={(subjects ?? []) as unknown as SubjectRow[]}
				tenantId={tenant.id}
				years={(years ?? []) as unknown as YearRow[]}
			/>
		</AppShell>
	);
}
