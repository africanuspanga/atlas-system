import Link from "next/link";

/**
 * Shared furniture for the legal pages.
 *
 * These pages are a substantive draft grounded in what the product verifiably
 * does — not legal advice, and not a claim of compliance. Tanzania's Personal
 * Data Protection Act 2022 work is tracked in
 * docs/audit/TANZANIA_PRIVACY_CHECKLIST.md and is NOT complete: PDPC
 * registration, school DPAs and the cross-border transfer permit are all
 * outstanding. Nothing here may assert otherwise.
 */

/** Everything the owner must supply before these pages can be published. */
export function Todo({ children }: { children: React.ReactNode }) {
	return <span className="ap-todo">[{children}]</span>;
}

export function DraftNotice({ page }: { page: string }) {
	return (
		<div className="ap-draft" style={{ marginTop: "var(--ap-lg)" }}>
			<p className="ap-caption-strong">Draft — not yet in force</p>
			<p
				className="ap-caption"
				style={{ marginTop: "var(--ap-xxs)", color: "var(--ap-ink-80)" }}
			>
				This {page} has not been reviewed by Tanzanian counsel and the bracketed
				details below are unfilled. It does not bind ATLAS or any school yet.
				Remove this notice only once counsel has approved the wording and the
				Personal Data Protection Commission steps in the internal privacy
				checklist are signed off.
			</p>
		</div>
	);
}

export function LegalHeader({
	title,
	updated,
	page,
}: {
	title: string;
	updated: string;
	page: string;
}) {
	return (
		<>
			<p className="ap-eyebrow">Legal</p>
			<h1 className="ap-display" style={{ marginTop: "var(--ap-sm)" }}>
				{title}
			</h1>
			<p
				className="ap-caption"
				style={{ marginTop: "var(--ap-xs)", color: "var(--ap-ink-48)" }}
			>
				Last updated {updated}
			</p>
			<DraftNotice page={page} />
		</>
	);
}

export function LegalFooterNav({ other }: { other: "terms" | "privacy" }) {
	return (
		<p
			className="ap-caption"
			style={{
				marginTop: "var(--ap-xxl)",
				paddingTop: "var(--ap-lg)",
				borderTop: "1px solid var(--ap-hairline)",
			}}
		>
			<Link className="ap-link" href={`/${other}`}>
				{other === "terms" ? "Terms of service" : "Privacy notice"}
			</Link>
			{" · "}
			<Link className="ap-link" href="/">
				Back to ATLAS
			</Link>
		</p>
	);
}
