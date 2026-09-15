"use client";

import { useId, useRef, useState } from "react";
import { MODULES } from "./content";
import { RegisterPhone, SmsPhone } from "./panels";
import { AppWindow } from "./shot";

/**
 * What answers each role's question.
 *
 * The head teacher and the accountant live on a screen, so they get a real
 * captured screen. The teacher and the parent do not: a teacher marks a
 * register on a phone and a parent only ever receives a text message, so
 * showing either as a desktop screenshot would misrepresent the product.
 */
const PANELS: Record<string, React.ReactNode> = {
	"Head teacher": (
		<AppWindow
			alt="The ATLAS dashboard, showing today's attendance and this month's collections"
			height={675}
			src="/screenshots/dashboard.png"
			width={1568}
		/>
	),
	Accountant: (
		<AppWindow
			alt="The debtors report, class by class"
			height={675}
			src="/screenshots/debtors.png"
			width={1568}
		/>
	),
	Teacher: <RegisterPhone />,
	Parent: <SmsPhone />,
};

/**
 * The page's signature: four people, four questions, one panel.
 *
 * A school does not buy "a system". The head teacher, the bursar, the teacher
 * and the parent each buy an answer to a different question. Making the reader
 * pick a role is the fastest way for them to find theirs, so the switcher is
 * the structure of the section rather than decoration on it.
 */
export function RoleSwitcher() {
	const [active, setActive] = useState(0);
	const baseId = useId();
	const tabsRef = useRef<HTMLDivElement>(null);
	const group = MODULES[active];

	// A tablist that only responds to clicks is a tablist in name only.
	function onKeyDown(event: React.KeyboardEvent) {
		const delta =
			event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (!delta) return;
		event.preventDefault();
		const next = (active + delta + MODULES.length) % MODULES.length;
		setActive(next);
		tabsRef.current
			?.querySelectorAll<HTMLButtonElement>("button")
			[next]?.focus();
	}

	return (
		<div>
			<div
				aria-label="Choose a role"
				className="ap-tabs"
				onKeyDown={onKeyDown}
				ref={tabsRef}
				role="tablist"
			>
				{MODULES.map((g, i) => (
					<button
						aria-controls={`${baseId}-panel`}
						aria-selected={i === active}
						className="ap-tab"
						id={`${baseId}-tab-${i}`}
						key={g.role}
						onClick={() => setActive(i)}
						role="tab"
						tabIndex={i === active ? 0 : -1}
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
				tabIndex={0}
			>
				<div className="ap-split">
					<div>
						<p className="ap-display-md">&ldquo;{group.question}&rdquo;</p>
						<ul className="ap-check" style={{ marginTop: "var(--ap-lg)" }}>
							{group.items.map((item) => (
								<li className="ap-body" key={item}>
									{item}
								</li>
							))}
						</ul>
					</div>
					{PANELS[group.role]}
				</div>
			</div>
		</div>
	);
}
