import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { StaffView } from "./staff-view";

export const metadata = { title: "Staff" };

export default async function StaffPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenants[0].name}>
			<StaffView lang={lang} tenantId={tenants[0].id} />
		</AppShell>
	);
}
