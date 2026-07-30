import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppHeader } from "@/components/app-header";
import { AppSidebar } from "@/components/app-sidebar";
import { AssistantLauncher } from "@/components/assistant-launcher";
import { createClient } from "@/lib/supabase/server";
import { getServerDict } from "@/i18n/server";

export async function AppShell({
	children,
	schoolName,
}: {
	children: React.ReactNode;
	schoolName?: string;
}) {
	const { lang } = await getServerDict();

	// Resolve the caller's tenant so the AI assistant is available on every
	// page (AI-native: the agent travels with the user, not one route).
	const supabase = await createClient();
	const { data: tenants } = await supabase
		.from("tenants")
		.select("id")
		.order("created_at", { ascending: true })
		.limit(1);
	const tenantId = tenants?.[0]?.id as string | undefined;

	return (
		<div className="overflow-hidden">
			<SidebarProvider className="relative h-svh">
				<AppSidebar lang={lang} schoolName={schoolName} />
				<SidebarInset className="md:peer-data-[variant=inset]:ml-0">
					<AppHeader lang={lang} />
					<div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 md:p-6">
						{children}
					</div>
					{tenantId && <AssistantLauncher lang={lang} tenantId={tenantId} />}
				</SidebarInset>
			</SidebarProvider>
		</div>
	);
}
