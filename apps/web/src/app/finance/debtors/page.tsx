import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { DebtorsView } from "./debtors-view";

export const metadata = { title: "Debtors" };

export default async function DebtorsPage() {
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

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<DebtorsView lang={lang} tenantId={tenant.id} />
		</AppShell>
	);
}
