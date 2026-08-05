import Link from "next/link";
import { LogoLockup } from "@/components/logo";
import { appHref } from "@/lib/hosts";

/**
 * One nav bar, not two.
 *
 * The mark is black with transparency, so the bar is light — a near-black bar
 * would swallow it. Frosted rather than solid so content passing underneath
 * stays faintly visible, which is what keeps a single sticky bar from feeling
 * like a lid.
 *
 * "Sign in" crosses to the app host, so it MUST be a plain <a>. A client-side
 * <Link> to the other surface is 307'd straight back out by the proxy.
 */
const LINKS = [
	{ label: "What it does", href: "#modules" },
	{ label: "Pricing", href: "#pricing" },
	{ label: "Blog", href: "/blog" },
];

export function MarketingNav() {
	return (
		<header className="ap-nav">
			<nav
				aria-label="Main"
				className="ap-inner-wide ap-nav-inner"
			>
				<Link aria-label="ATLAS home" className="ap-nav-brand" href="/">
					<LogoLockup priority />
				</Link>

				<div className="ap-nav-links">
					{LINKS.map((l) => (
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
			</nav>
		</header>
	);
}
