import Link from "next/link";
import { LogoIcon } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";
import { NavGroup } from "@/components/nav-group";
import {
	footerNavLinks as defaultFooter,
	navGroups as defaultGroups,
	type SidebarNavGroup,
	type SidebarNavItem,
} from "@/components/app-shared";
import { LatestChange } from "@/components/latest-change";
import { PlusIcon, SearchIcon } from "lucide-react";

export function AppSidebar({
	schoolName,
	groups = defaultGroups,
	footerLinks = defaultFooter,
	quickCreateLabel = "Quick create",
	searchLabel = "Search",
}: {
	schoolName?: string;
	groups?: SidebarNavGroup[];
	footerLinks?: SidebarNavItem[];
	quickCreateLabel?: string;
	searchLabel?: string;
}) {
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
				<SidebarGroup>
					<SidebarMenuItem className="flex items-center gap-2">
						<SidebarMenuButton
							className="min-w-8 bg-primary text-primary-foreground duration-200 ease-linear hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground"
							tooltip="Quick Create"
						>
							<PlusIcon
							/>
							<span>{quickCreateLabel}</span>
						</SidebarMenuButton>
						<Button
							aria-label={searchLabel}
							className="size-8 group-data-[collapsible=icon]:opacity-0"
							size="icon"
							variant="outline"
						>
							<SearchIcon
							/>
							<span className="sr-only">{searchLabel}</span>
						</Button>
					</SidebarMenuItem>
				</SidebarGroup>
				{groups.map((group, index) => (
					<NavGroup key={`sidebar-group-${index}`} {...group} />
				))}
			</SidebarContent>
			<SidebarFooter>
				<LatestChange />
				<SidebarMenu className="mt-2">
					{footerLinks.map((item) => (
						<SidebarMenuItem key={item.title}>
							<SidebarMenuButton className="text-muted-foreground" isActive={item.isActive} size="sm" render={<a href={item.path} />}>{item.icon}<span>{item.title}</span></SidebarMenuButton>
						</SidebarMenuItem>
					))}
				</SidebarMenu>
			</SidebarFooter>
		</Sidebar>
	);
}
