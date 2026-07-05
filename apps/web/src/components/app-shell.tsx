import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { buildFooterLinks, buildNavGroups } from "@/components/app-shared";
import { getServerDict } from "@/i18n/server";

export async function AppShell({
	children,
	schoolName,
}: {
	children: React.ReactNode;
	schoolName?: string;
}) {
	const { lang, t } = await getServerDict();

	return (
		<div className="overflow-hidden">
			<SidebarProvider className="relative h-svh">
				<AppSidebar
					footerLinks={buildFooterLinks(t)}
					groups={buildNavGroups(t)}
					quickCreateLabel={t("common.quickCreate")}
					schoolName={schoolName}
					searchLabel={t("common.search")}
				/>
				<SidebarInset className="md:peer-data-[variant=inset]:ml-0">
					<AppHeader lang={lang} />
					<div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">
						{children}
					</div>
				</SidebarInset>
			</SidebarProvider>
		</div>
	);
}
