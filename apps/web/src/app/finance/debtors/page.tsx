import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import { DebtorsView } from "./debtors-view";

export const metadata = { title: "Debtors" };

export default async function DebtorsPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];


	return (
		<AppShell schoolName={tenant.name}>
			<DebtorsView tenantId={tenant.id} />
		</AppShell>
	);
}
