import type React from "react";

/**
 * ATLAS mark — a globe with meridians, nodding to "atlas" as the map of the
 * whole school. Inherits currentColor so it works in the sidebar and on
 * primary surfaces.
 */
export const LogoIcon = (props: React.ComponentProps<"svg">) => (
	<svg
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		{...props}
	>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
		<path d="M2 12h20" />
	</svg>
);

export const Logo = (props: React.ComponentProps<"div">) => (
	<div className="flex items-center gap-2" {...props}>
		<LogoIcon className="size-5" />
		<span className="text-lg font-semibold tracking-tight">ATLAS</span>
	</div>
);
