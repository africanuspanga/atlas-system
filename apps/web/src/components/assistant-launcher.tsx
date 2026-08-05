"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { SparklesIcon } from "lucide-react";
import { getDict } from "@/i18n";
import { AssistantView } from "@/app/assistant/assistant-view";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";

export function AssistantLauncher({ tenantId }: { tenantId: string }) {
	const t = getDict();
	const pathname = usePathname();
	const [open, setOpen] = useState(false);

	// The /assistant page already is the assistant — no launcher there.
	if (pathname.startsWith("/assistant")) return null;

	return (
		<Sheet onOpenChange={setOpen} open={open}>
			<SheetTrigger
				render={<Button className="fixed right-5 bottom-5 z-40 h-11 shadow-lg" size="lg" />}
			>
				<SparklesIcon /> {t("assistant.launcher")}
			</SheetTrigger>
			<SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg" side="right">
				<SheetHeader className="border-b">
					<SheetTitle className="flex items-center gap-2 text-base">
						<SparklesIcon className="size-4" /> {t("assistant.title")}
					</SheetTitle>
				</SheetHeader>
				<div className="min-h-0 flex-1">
					<AssistantView embedded tenantId={tenantId} />
				</div>
			</SheetContent>
		</Sheet>
	);
}
