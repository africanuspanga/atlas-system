import type { ReactNode } from "react";
import {
	LayoutGridIcon,
	ClipboardListIcon,
	GraduationCapIcon,
	BookOpenIcon,
	CalendarCheckIcon,
	FileSpreadsheetIcon,
	WalletIcon,
	ScaleIcon,
	UsersIcon,
	MegaphoneIcon,
	BriefcaseIcon,
	BusIcon,
	BedDoubleIcon,
	LibraryIcon,
	PackageIcon,
	HeartPulseIcon,
	BarChart3Icon,
	SettingsIcon,
	LifeBuoyIcon,
} from "lucide-react";
import { getDict, type Translator } from "@/i18n";

export type SidebarNavItem = {
	title: string;
	path?: string;
	icon?: ReactNode;
	isActive?: boolean;
	subItems?: SidebarNavItem[];
};

export type SidebarNavGroup = {
	label?: string;
	items: SidebarNavItem[];
};

/**
 * ATLAS module navigation, translated at render time.
 *
 * NOTE: once subscriptions are wired, this list is additionally filtered by
 * the member's permissions and the tenant's plan.
 */
export function buildNavGroups(t: Translator): SidebarNavGroup[] {
	return [
		{
			items: [
				{ title: t("nav.overview"), path: "/", icon: <LayoutGridIcon />, isActive: true },
			],
		},
		{
			label: t("nav.group.school"),
			items: [
				{ title: t("nav.admissions"), path: "/admissions", icon: <ClipboardListIcon /> },
				{ title: t("nav.students"), path: "/students", icon: <GraduationCapIcon /> },
				{ title: t("nav.academics"), path: "/academics", icon: <BookOpenIcon /> },
				{ title: t("nav.attendance"), path: "/attendance", icon: <CalendarCheckIcon /> },
				{ title: t("nav.assessments"), path: "/assessments", icon: <FileSpreadsheetIcon /> },
			],
		},
		{
			label: t("nav.group.money"),
			items: [
				{ title: t("nav.finance"), path: "/finance", icon: <WalletIcon /> },
				{ title: t("nav.accounting"), path: "/accounting", icon: <ScaleIcon /> },
			],
		},
		{
			label: t("nav.group.community"),
			items: [
				{ title: t("nav.parents"), path: "/parents", icon: <UsersIcon /> },
				{ title: t("nav.communication"), path: "/communication", icon: <MegaphoneIcon /> },
			],
		},
		{
			label: t("nav.group.operations"),
			items: [
				{ title: t("nav.staff"), path: "/staff", icon: <BriefcaseIcon /> },
				{ title: t("nav.transport"), path: "/transport", icon: <BusIcon /> },
				{ title: t("nav.hostel"), path: "/hostel", icon: <BedDoubleIcon /> },
				{ title: t("nav.library"), path: "/library", icon: <LibraryIcon /> },
				{ title: t("nav.inventory"), path: "/inventory", icon: <PackageIcon /> },
				{ title: t("nav.clinic"), path: "/clinic", icon: <HeartPulseIcon /> },
			],
		},
		{
			label: t("nav.group.system"),
			items: [
				{ title: t("nav.reports"), path: "/reports", icon: <BarChart3Icon /> },
				{ title: t("nav.settings"), path: "/settings", icon: <SettingsIcon /> },
			],
		},
	];
}

export function buildFooterLinks(t: Translator): SidebarNavItem[] {
	return [{ title: t("nav.support"), path: "/support", icon: <LifeBuoyIcon /> }];
}

// English fallbacks used by the breadcrumb lookup in the client header.
export const navGroups: SidebarNavGroup[] = buildNavGroups(getDict("en"));
export const footerNavLinks: SidebarNavItem[] = buildFooterLinks(getDict("en"));

export const navLinks: SidebarNavItem[] = [
	...navGroups.flatMap((group) =>
		group.items.flatMap((item) =>
			item.subItems?.length ? [item, ...item.subItems] : [item]
		)
	),
	...footerNavLinks,
];
