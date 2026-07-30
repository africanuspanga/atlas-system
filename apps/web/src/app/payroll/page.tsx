import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { PayrollView } from "./payroll-view";

export const metadata = { title: "Payroll" };

const MANAGE_SUPER_ROLES = ["school_owner", "director"];

export default async function PayrollPage() {
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

	// Manage rights: owner/director are superusers; otherwise the member needs
	// a role that carries payroll.manage (simple RLS read — the API re-checks
	// on every request; salary DATA itself is API-only, no RLS reads).
	const { data: memberships } = await supabase
		.from("tenant_memberships")
		.select("id, membership_roles(roles(id, key))")
		.eq("tenant_id", tenant.id)
		.eq("user_id", user.id)
		.eq("status", "active");

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
			.eq("permission_key", "payroll.manage");
		canManage = (perms ?? []).length > 0;
	}

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<PayrollView canManage={canManage} lang={lang} tenantId={tenant.id} />
		</AppShell>
	);
}
