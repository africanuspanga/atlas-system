"use client";

import { cn } from "@/lib/utils";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getDict, type Lang } from "@/i18n";
import { XIcon } from "lucide-react";

export function LatestChange({ lang = "en" }: { lang?: Lang }) {
	const t = getDict(lang);
	// Keep descriptions to a single short line (max ~5 words).
	const latestChange = {
		badge: t("pilot.badge"),
		title: t("pilot.title"),
		description: t("pilot.desc"),
	};
	const [isOpen, setIsOpen] = useState(true);

	if (!isOpen) {
		return null;
	}

	return (
		<div
			className={cn(
				"rounded-lg group/latest-change size-full min-h-27 justify-center border bg-background",
				"relative flex size-full flex-col gap-1 overflow-hidden px-4 pt-3 pb-1 *:text-nowrap",
				"transition-opacity group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:opacity-0"
			)}
		>
			<span className="font-light font-mono text-[10px] text-muted-foreground">
				{latestChange.badge}
			</span>
			<p className="font-medium text-xs">{latestChange.title}</p>
			<span className="text-[10px] text-muted-foreground">
				{latestChange.description}
			</span>
			<Button
				aria-label={t("common.close")}
				className="absolute top-2 right-2 z-10 size-6 rounded-full"
				onClick={() => setIsOpen(false)}
				size="icon-sm"
				variant="ghost"
			>
				<XIcon className="size-3.5 text-muted-foreground" />
			</Button>
		</div>
	);
}
