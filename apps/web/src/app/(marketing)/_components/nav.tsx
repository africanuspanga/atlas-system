import Link from "next/link";
import { LogoLockup } from "@/components/logo";
import { appHref } from "@/lib/hosts";

/**
 * Two-row nav: the slim near-black global bar, then the frosted sub-nav that
 * carries the product name and the persistent CTA.
 *
 * "Sign in" crosses to the app host, so it MUST be a plain <a>. A client-side
 * <Link> would be 307'd straight back out by the proxy.
 */
export function MarketingNav() {
	return (
		<header>
			<div className="ap-globalnav">
				<nav
					className="ap-inner-wide"
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: "var(--ap-lg)",
						height: 44,
						paddingInline: "var(--ap-lg)",
					}}
				>
					<Link
						className="ap-navlink"
						href="/"
						style={{ fontWeight: 600, letterSpacing: "0.02em" }}
					>
						ATLAS
					</Link>
					<div style={{ display: "flex", gap: "var(--ap-lg)" }}>
						<Link className="ap-navlink" href="#modules">
							What it does
						</Link>
						<Link className="ap-navlink" href="#pricing">
							Pricing
						</Link>
						<Link className="ap-navlink" href="/blog">
							Blog
						</Link>
						<a className="ap-navlink" href={appHref("/login")}>
							Sign in
						</a>
					</div>
				</nav>
			</div>

			<div
				className="ap-subnav"
				style={{ position: "sticky", top: 0, zIndex: 40 }}
			>
				<div
					className="ap-inner-wide"
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: "var(--ap-lg)",
						height: 52,
						paddingInline: "var(--ap-lg)",
					}}
				>
					<Link
						href="/"
						style={{ display: "flex", alignItems: "center", gap: 8 }}
					>
						<LogoLockup
							className="h-5 w-auto"
							priority
						/>
						<span className="sr-only">ATLAS home</span>
					</Link>
					<Link className="ap-btn" href="/anza" style={{ minHeight: 36, padding: "8px 18px", fontSize: 14 }}>
						Book a demo
					</Link>
				</div>
			</div>
		</header>
	);
}
