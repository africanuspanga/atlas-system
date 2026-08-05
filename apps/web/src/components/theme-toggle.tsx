"use client";

import { useCallback, useSyncExternalStore } from "react";
import { MoonIcon, SunIcon } from "lucide-react";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { getDict } from "@/i18n";

export const THEME_KEY = "atlas-theme";

/** Notifies React when the `dark` class on <html> changes. */
function subscribe(onChange: () => void) {
	const observer = new MutationObserver(onChange);
	observer.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class"],
	});
	return () => observer.disconnect();
}

const isDarkNow = () => document.documentElement.classList.contains("dark");
/** The server cannot know the browser's theme; the class is applied pre-paint. */
const isDarkOnServer = () => false;

/**
 * Light/dark toggle.
 *
 * The dark palette already exists in globals.css under `.dark` (see design.md);
 * this only decides when that class is on <html>. The initial class is applied
 * by an inline script in the root layout BEFORE paint — doing it here would
 * flash the light theme on every load for anyone who chose dark.
 *
 * The <html> class is the single source of truth, read through
 * useSyncExternalStore rather than mirrored into component state, so the button
 * stays correct even if the class is changed from somewhere else.
 *
 * First visit follows the operating system. Once someone picks a side, that
 * choice is remembered and the OS no longer overrides it.
 */
export function ThemeToggle() {
	const t = getDict();
	const isDark = useSyncExternalStore(subscribe, isDarkNow, isDarkOnServer);

	const toggle = useCallback(() => {
		const next = !document.documentElement.classList.contains("dark");
		document.documentElement.classList.toggle("dark", next);
		try {
			localStorage.setItem(THEME_KEY, next ? "dark" : "light");
		} catch {
			// Private mode or storage disabled — the toggle still works for this
			// session, it just will not be remembered.
		}
	}, []);

	const label = isDark ? t("theme.light") : t("theme.dark");

	return (
		<SidebarMenuButton
			aria-label={t("theme.toggle")}
			aria-pressed={isDark}
			onClick={toggle}
			title={t("theme.toggle")}
			tooltip={label}
			type="button"
		>
			{/* Both icons render; only one is visible per theme, so the button never
			    changes size or reflows when toggled. */}
			<SunIcon className="hidden dark:block" />
			<MoonIcon className="block dark:hidden" />
			<span>{label}</span>
		</SidebarMenuButton>
	);
}
