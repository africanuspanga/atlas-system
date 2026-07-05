"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { LANG_COOKIE, type Lang } from "@/i18n";

export function LanguageSwitcher({ current }: { current: Lang }) {
	const router = useRouter();

	function setLang(lang: Lang) {
		document.cookie = `${LANG_COOKIE}=${lang};path=/;max-age=${60 * 60 * 24 * 365}`;
		router.refresh();
	}

	return (
		<Button
			aria-label="Switch language / Badili lugha"
			onClick={() => setLang(current === "en" ? "sw" : "en")}
			size="sm"
			variant="outline"
		>
			{current === "en" ? "SW" : "EN"}
		</Button>
	);
}
