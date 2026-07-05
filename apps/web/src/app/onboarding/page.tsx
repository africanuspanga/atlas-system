import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { LogoIcon } from "@/components/logo";
import { OnboardingWizard } from "./onboarding-wizard";

export const metadata = { title: "Set up your school" };

export default async function OnboardingPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) {
		redirect("/login");
	}

	// Already a member of a school → straight to the dashboard.
	const { data: tenants } = await supabase.from("tenants").select("id").limit(1);
	if (tenants && tenants.length > 0) {
		redirect("/");
	}

	return (
		<div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col gap-6 p-4 py-10">
			<div className="flex items-center gap-2 text-primary">
				<LogoIcon className="size-6" />
				<span className="text-xl font-semibold tracking-tight text-foreground">ATLAS</span>
			</div>
			<OnboardingWizard email={user.email ?? ""} />
		</div>
	);
}
