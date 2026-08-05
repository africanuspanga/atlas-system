"use client";

import Link from "next/link";
import { LogoIcon } from "@/components/logo";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenuButton,
} from "@/components/ui/sidebar";
import { NavGroup } from "@/components/nav-group";
import { buildNavGroups } from "@/components/app-shared";
import { LatestChange } from "@/components/latest-change";
import { getDict } from "@/i18n";

export function AppSidebar({
	schoolName,
}: {
	schoolName?: string;
}) {
	// Nav is built client-side from the lang string so icon elements never
	// cross the server→client boundary.
	const groups = buildNavGroups(getDict());
	return (
		<Sidebar collapsible="icon" variant="inset">
			<SidebarHeader className="h-14 justify-center">
				<SidebarMenuButton render={<Link href="/" />}>
					<LogoIcon />
					<span className="flex min-w-0 flex-col leading-tight">
						<span className="font-semibold tracking-tight">ATLAS</span>
						{schoolName && (
							<span className="truncate text-[10px] text-muted-foreground">{schoolName}</span>
						)}
					</span>
				</SidebarMenuButton>
			</SidebarHeader>
			<SidebarContent>
				{groups.map((group, index) => (
					<NavGroup key={`sidebar-group-${index}`} {...group} />
				))}
			</SidebarContent>
			<SidebarFooter>
				<LatestChange />
			</SidebarFooter>
		</Sidebar>
	);
}
