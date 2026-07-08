import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { AssistantView } from "./assistant-view";

export const metadata = { title: "ATLAS Assistant" };

export default async function AssistantPage() {
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
			<AssistantView lang={lang} tenantId={tenants[0].id} />
		</AppShell>
	);
}
