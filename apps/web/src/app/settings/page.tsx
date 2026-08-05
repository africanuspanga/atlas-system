import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import { SettingsView, type TenantProfile } from "./settings-view";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: activeTenants } = await getActiveTenants(supabase);
	if (!activeTenants || activeTenants.length === 0) redirect("/onboarding");
	const { data: tenants } = await supabase
		.from("tenants")
		.select(
			"id, name, slug, status, region, district, address, phone, email, default_language, currency, timezone",
		)
		.eq("id", activeTenants[0].id)
		.limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];



	return (
		<AppShell schoolName={tenant.name}>
			<SettingsView
				tenant={tenant as TenantProfile}
			/>
		</AppShell>
	);
}
