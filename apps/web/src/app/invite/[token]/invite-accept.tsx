"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
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
		try {
			const response = await apiFetch("/api/v1/invitations/accept", {
				method: "POST",
				body: JSON.stringify({ token }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			const body = await response.json().catch(() => null);
			setAccepted(true);
			router.push(body?.portal === "parent" ? "/portal" : "/");
			router.refresh();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
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
