import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { Dashboard } from "@/components/dashboard";

export default async function Home() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) {
		redirect("/login");
	}

	// RLS: members only see their own tenants.
	const { data: tenants } = await supabase
		.from("tenants")
		.select("id, name, status")
		.limit(1);
	if (!tenants || tenants.length === 0) {
		redirect("/onboarding");
	}

	return (
		<AppShell schoolName={tenants[0].name}>
			<Dashboard />
		</AppShell>
	);
}
