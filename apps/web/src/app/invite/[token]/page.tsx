import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getServerDict } from "@/i18n/server";
import { LogoIcon } from "@/components/logo";
import { InviteAccept } from "./invite-accept";

export const metadata = { title: "Invitation" };

export default async function InvitePage({
	params,
}: {
	params: Promise<{ token: string }>;
}) {
	const { token } = await params;
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) {
		redirect(`/login?next=/invite/${token}`);
	}

	const { lang, t } = await getServerDict();

	return (
		<div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4">
			<div className="flex items-center gap-2 text-primary">
				<LogoIcon className="size-7" />
				<span className="text-2xl font-semibold tracking-tight text-foreground">ATLAS</span>
			</div>
			<div className="w-full max-w-sm text-center">
				<h1 className="text-lg font-semibold">{t("invite.title")}</h1>
				<p className="mt-1 text-sm text-muted-foreground">{t("invite.description")}</p>
				<InviteAccept lang={lang} token={token} />
			</div>
		</div>
	);
}
