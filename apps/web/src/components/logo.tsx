import Image from "next/image";
import type React from "react";

/**
 * The ATLAS mark: a peak over an open book — knowledge held up, the "A" of
 * Atlas. Drawn as filled paths inheriting currentColor so it works in the
 * sidebar, on dark tiles and on primary surfaces.
 *
 * The full lockup lives at /atlas-logo.png and is used on marketing surfaces
 * via <LogoLockup>; this icon is the monochrome in-product mark.
 */
export const LogoIcon = (props: React.ComponentProps<"svg">) => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
		{/* peak — an open-based triangle, the "A" without its crossbar */}
		<path d="M12 1.6 22.6 14.2h-5.9L12 8.4l-4.7 5.8H1.4Z" />
		{/* open book — two leaves meeting at the spine */}
		<path d="M1.4 16.2h6.9c1.6 0 2.9.7 3.7 1.9.8-1.2 2.1-1.9 3.7-1.9h6.9l-2.6 3.4h-4.3c-1.6 0-2.9.7-3.7 1.9-.8-1.2-2.1-1.9-3.7-1.9H4Z" />
	</svg>
);

/** Icon + wordmark, for the app sidebar and compact headers. */
export const Logo = (props: React.ComponentProps<"div">) => (
	<div className="flex items-center gap-2" {...props}>
		<LogoIcon className="size-5" />
		<span className="text-lg font-semibold tracking-tight">ATLAS</span>
	</div>
);

/**
 * The real lockup asset, for marketing surfaces where the brand should appear
 * exactly as drawn rather than as a monochrome glyph.
 */
export const LogoLockup = ({
	className,
	priority = false,
}: {
	className?: string;
	priority?: boolean;
}) => (
	<Image
		alt="ATLAS"
		className={className}
		height={411}
		priority={priority}
		src="/atlas-logo.png"
		width={1184}
	/>
);
