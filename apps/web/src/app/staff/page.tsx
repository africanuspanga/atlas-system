import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import { StaffView } from "./staff-view";

export const metadata = { title: "Staff" };

export default async function StaffPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");

	return (
		<AppShell schoolName={tenants[0].name}>
			<StaffView tenantId={tenants[0].id} />
		</AppShell>
	);
}
