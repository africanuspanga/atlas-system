import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PlatformView } from "./platform-view";

export const metadata = { title: "ATLAS Control Centre" };

/**
 * Platform-staff area — deliberately OUTSIDE the tenant AppShell. Access is
 * enforced server-side by the API's PlatformGuard (profiles.platform_role);
 * this page only requires a login and lets the API decide.
 */
export default async function PlatformPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login?next=/platform");

	return <PlatformView />;
}
