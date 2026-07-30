import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { HostelView, type StudentOption } from "./hostel-view";

export const metadata = { title: "Hostel" };

const MANAGE_SUPER_ROLES = ["school_owner", "director"];

export default async function HostelPage() {
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

	const [{ data: students }, { data: years }, { data: memberships }] = await Promise.all([
		supabase
			.from("students")
			.select("id, student_number, first_name, last_name, gender, boarding_status")
			.eq("status", "active")
			.order("student_number")
			.limit(1000),
		supabase
			.from("academic_years")
			.select("id, name")
			.eq("status", "active")
			.order("starts_on", { ascending: false })
			.limit(1),
		supabase
			.from("tenant_memberships")
			.select("id, membership_roles(roles(id, key))")
			.eq("tenant_id", tenant.id)
			.eq("user_id", user.id)
			.eq("status", "active"),
	]);

	// Manage rights: owner/director are superusers; otherwise the member needs
	// a role that carries hostel.manage (simple RLS read — the API re-checks
	// on every write anyway).
	const roles = (memberships ?? []).flatMap((m) =>
		(m.membership_roles ?? []).map(
			(r) => r.roles as unknown as { id: string; key: string } | null,
		),
	);
	let canManage = roles.some((r) => r && MANAGE_SUPER_ROLES.includes(r.key));
	if (!canManage && roles.length > 0) {
		const { data: perms } = await supabase
			.from("role_permissions")
			.select("permission_key")
			.in(
				"role_id",
				roles.filter((r) => r !== null).map((r) => r.id),
			)
			.eq("permission_key", "hostel.manage");
		canManage = (perms ?? []).length > 0;
	}

	const studentOptions: StudentOption[] = (students ?? []).map((s) => ({
		id: s.id,
		studentNumber: s.student_number,
		name: `${s.first_name} ${s.last_name}`,
		gender: s.gender,
		boardingStatus: s.boarding_status,
	}));

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<HostelView
				academicYear={(years ?? [])[0] ?? null}
				canManage={canManage}
				lang={lang}
				students={studentOptions}
				tenantId={tenant.id}
			/>
		</AppShell>
	);
}
