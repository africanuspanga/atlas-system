"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { LogoLockup } from "@/components/logo";
import { appHref } from "@/lib/hosts";

/**
 * One nav bar, not two.
 *
 * The mark is black with transparency, so the bar is light. A near-black bar
 * would swallow it. Frosted rather than solid so content passing underneath
 * stays faintly visible, which is what keeps a single sticky bar from feeling
 * like a lid.
 *
 * "Sign in" crosses to the app host, so it MUST be a plain <a>. A client-side
 * <Link> to the other surface is 307'd straight back out by the proxy.
 *
 * Section links are absolute ("/#pricing", not "#pricing"). A bare hash on
 * /blog resolves to /blog#pricing, which is nowhere.
 */
const LINKS = [
	{ label: "What it does", href: "/#modules" },
	{ label: "Pricing", href: "/#pricing" },
	{ label: "Take a look around", href: "/tour", mobileOnly: true },
	{ label: "Blog", href: "/blog" },
];

export function MarketingNav() {
	const [open, setOpen] = useState(false);

	// A menu that survives a route change is a menu covering the page you just
	// asked for.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	return (
		<header className="ap-nav">
			<nav aria-label="Main" className="ap-inner-wide ap-nav-inner">
				<Link
					aria-label="ATLAS home"
					className="ap-nav-brand"
					href="/"
					onClick={() => setOpen(false)}
				>
					<LogoLockup priority />
				</Link>

				<div className="ap-nav-links">
					{LINKS.filter((l) => !l.mobileOnly).map((l) => (
						<Link className="ap-nav-link" href={l.href} key={l.label}>
							{l.label}
						</Link>
					))}
					<a className="ap-nav-link" href={appHref("/login")}>
						Sign in
					</a>
					<Link className="ap-btn ap-nav-cta" href="/anza">
						Book a demo
					</Link>
				</div>

				<button
					aria-controls="ap-nav-sheet"
					aria-expanded={open}
					aria-label={open ? "Close menu" : "Open menu"}
					className="ap-nav-toggle"
					onClick={() => setOpen((v) => !v)}
					type="button"
				>
					<svg
						aria-hidden="true"
						fill="none"
						height="20"
						stroke="currentColor"
						strokeLinecap="round"
						strokeWidth="1.6"
						viewBox="0 0 20 20"
						width="20"
					>
						{open ? (
							<>
								<path d="M4 4l12 12" />
								<path d="M16 4L4 16" />
							</>
						) : (
							<>
								<path d="M2.5 6h15" />
								<path d="M2.5 14h15" />
							</>
						)}
					</svg>
				</button>
			</nav>

			<div className="ap-nav-sheet" data-open={open} id="ap-nav-sheet">
				{LINKS.map((l) => (
					<Link
						className="ap-nav-link"
						href={l.href}
						key={l.label}
						onClick={() => setOpen(false)}
					>
						{l.label}
					</Link>
				))}
				<a className="ap-nav-link" href={appHref("/login")}>
					Sign in
				</a>
				<Link className="ap-btn" href="/anza" onClick={() => setOpen(false)}>
					Book a demo
				</Link>
			</div>
		</header>
	);
}
