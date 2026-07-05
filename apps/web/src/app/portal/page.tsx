import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getServerDict } from "@/i18n/server";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/logo";
import { PortalView } from "./portal-view";

export const metadata = { title: "Parent portal" };

export default async function PortalPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { lang } = await getServerDict();

	return (
		<div className="min-h-svh bg-muted/30">
			<header className="flex items-center justify-between border-b bg-background px-4 py-3">
				<Logo />
				<LanguageSwitcher current={lang} />
			</header>
			<main className="mx-auto w-full max-w-3xl p-4">
				<PortalView lang={lang} />
			</main>
		</div>
	);
}
