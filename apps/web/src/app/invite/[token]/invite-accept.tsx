"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { getDict, type Lang } from "@/i18n";
import { Button } from "@/components/ui/button";

export function InviteAccept({ token, lang }: { token: string; lang: Lang }) {
	const t = getDict(lang);
	const router = useRouter();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [accepted, setAccepted] = useState(false);

	async function accept() {
		setPending(true);
		setError(null);
		const response = await apiFetch("/api/v1/invitations/accept", {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		setPending(false);
		if (!response.ok) {
			const body = await response.json().catch(() => null);
			setError(body?.message ?? body?.code ?? `HTTP ${response.status}`);
			return;
		}
		const body = await response.json().catch(() => null);
		setAccepted(true);
		router.push(body?.portal === "parent" ? "/portal" : "/");
		router.refresh();
	}

	return (
		<div className="mt-4 flex flex-col gap-3">
			{accepted ? (
				<p className="text-sm text-primary">{t("invite.success")}</p>
			) : (
				<Button disabled={pending} onClick={accept}>
					{pending ? t("common.loading") : t("invite.accept")}
				</Button>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
		</div>
	);
}
