"use client";

import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import { AppBreadcrumbs } from "@/components/app-breadcrumbs";
import { CustomSidebarTrigger } from "@/components/custom-sidebar-trigger";
import {
	buildNavGroups,
	flattenNavItems,
	isNavItemActive,
	type SidebarNavItem,
} from "@/components/app-shared";
import { NavUser } from "@/components/nav-user";
import { LanguageSwitcher } from "@/components/language-switcher";
import { getDict, type Lang } from "@/i18n";

export function AppHeader({ lang = "en" }: { lang?: Lang }) {
	const t = getDict(lang);
	const pathname = usePathname();

	// Breadcrumb = the nav item whose path best (longest) matches the route,
	// so sub-pages like /students/…/report-card still read "Students".
	const activeItem = flattenNavItems(buildNavGroups(t)).reduce<SidebarNavItem | null>(
		(best, item) => {
			if (!item.path || !isNavItemActive(pathname, item.path)) return best;
			return !best || (best.path?.length ?? 0) < item.path.length ? item : best;
		},
		null,
	);

	return (
		<header
			className={cn(
				"sticky top-0 z-50 flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4 md:px-6"
			)}
		>
			<div className="flex items-center gap-3">
				<CustomSidebarTrigger />
				<Separator
					className="mr-2 h-4 data-[orientation=vertical]:self-center"
					orientation="vertical"
				/>
				<AppBreadcrumbs page={activeItem} />
			</div>
			<div className="flex items-center gap-3">
				<LanguageSwitcher current={lang} />
				<Separator
					className="h-4 data-[orientation=vertical]:self-center"
					orientation="vertical"
				/>
				<NavUser lang={lang} />
			</div>
		</header>
	);
}
