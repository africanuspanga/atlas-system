import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import { InventoryView } from "./inventory-view";

export const metadata = { title: "Inventory" };

const MANAGE_SUPER_ROLES = ["school_owner", "director"];

export default async function InventoryPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const { data: memberships } = await supabase
		.from("tenant_memberships")
		.select("id, membership_roles(roles(id, key))")
		.eq("tenant_id", tenant.id)
		.eq("user_id", user.id)
		.eq("status", "active");

	// Manage rights: owner/director are superusers; otherwise the member needs
	// a role that carries inventory.manage (simple RLS read — the API re-checks
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
			.eq("permission_key", "inventory.manage");
		canManage = (perms ?? []).length > 0;
	}


	return (
		<AppShell schoolName={tenant.name}>
			<InventoryView canManage={canManage} tenantId={tenant.id} />
		</AppShell>
	);
}
