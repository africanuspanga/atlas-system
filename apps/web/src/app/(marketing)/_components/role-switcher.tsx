"use client";

import { useId, useState } from "react";
import { MODULES } from "./content";
import { AppWindow } from "./shot";

/** The screen that answers each role's question. */
const SHOTS: Record<string, { alt: string; needs: string }> = {
	"Head teacher": {
		alt: "The ATLAS dashboard",
		needs: "/dashboard as a head teacher, demo tenant",
	},
	Accountant: {
		alt: "The debtors report, class by class",
		needs: "/finance/debtors as a bursar",
	},
	Teacher: {
		alt: "Marking attendance for a class",
		needs: "/attendance with a class register open",
	},
	Parent: {
		alt: "The parent portal",
		needs: "/portal as a linked guardian",
	},
};

/**
 * The page's signature: four people, four questions, one panel.
 *
 * A school does not buy "a system" — the head teacher, the bursar, the
 * teacher and the parent each buy an answer to a different question. Making
 * the reader pick a role is the fastest way for them to find theirs, so the
 * switcher is the structure of the section rather than decoration on it.
 */
export function RoleSwitcher() {
	const [active, setActive] = useState(0);
	const baseId = useId();
	const group = MODULES[active];
	const shot = SHOTS[group.role];

	return (
		<div>
			<div aria-label="Choose a role" className="ap-tabs" role="tablist">
				{MODULES.map((g, i) => (
					<button
						aria-controls={`${baseId}-panel`}
						aria-selected={i === active}
						className="ap-tab"
						id={`${baseId}-tab-${i}`}
						key={g.role}
						onClick={() => setActive(i)}
						role="tab"
						type="button"
					>
						{g.role}
					</button>
				))}
			</div>

			<div
				aria-labelledby={`${baseId}-tab-${active}`}
				id={`${baseId}-panel`}
				role="tabpanel"
				style={{ marginTop: "var(--ap-xxl)" }}
			>
				<div className="ap-split">
					<div>
						<p className="ap-display-md">“{group.question}”</p>
						<ul className="ap-check" style={{ marginTop: "var(--ap-lg)" }}>
							{group.items.map((item) => (
								<li className="ap-body" key={item}>
									{item}
								</li>
							))}
						</ul>
					</div>
					<AppWindow
						alt={shot.alt}
						height={1200}
						needs={shot.needs}
						width={1900}
					/>
				</div>
			</div>
		</div>
	);
}
