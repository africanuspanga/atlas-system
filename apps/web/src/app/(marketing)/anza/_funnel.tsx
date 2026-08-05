"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	FREE_SMS,
	INCLUSIONS,
	PRICE_TZS,
	fmtTZS,
	perStudentPerMonth,
	perStudentPerYear,
} from "@/lib/offer";
import type { PublicSchool } from "@/lib/schools";

/**
 * The whole funnel is ONE client component holding local state, with no route
 * change between steps. Going back costs nothing, and a dropped connection
 * does not lose the answers already given.
 *
 * The school is captured BEFORE the price: somebody who balks at 2.5 million
 * is still a named school in the pipeline rather than an anonymous bounce.
 */
export function Funnel({
	preselected,
	outreachCode,
}: {
	preselected: PublicSchool | null;
	/** Recorded even when it matched no school. */
	outreachCode?: string;
}) {
	// Always start at the qualify question, even when a tracked SMS link already
	// identified the school. Skipping to step 2 meant every SMS-sourced lead —
	// the primary channel — arrived with usesSystem null, losing the one thing
	// step 1 exists to capture. The preselection still makes step 2 a single tap.
	const [step, setStep] = useState(1);
	const [usesSystem, setUsesSystem] = useState<boolean | undefined>();
	const [school, setSchool] = useState<PublicSchool | null>(preselected);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<PublicSchool[]>([]);
	const [searching, setSearching] = useState(false);

	const [contactName, setContactName] = useState("");
	const [phone, setPhone] = useState("");
	const [preferredDay, setPreferredDay] = useState("");
	const [website, setWebsite] = useState(""); // honeypot

	const [submitting, setSubmitting] = useState(false);
	const [done, setDone] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const liveRef = useRef<HTMLParagraphElement>(null);

	// Autocomplete after 3 characters, debounced. Nothing is set synchronously
	// here — a synchronous setState inside an effect triggers cascading renders.
	useEffect(() => {
		const q = query.trim();
		if (q.length < 3) return;
		let ignore = false;
		const timer = setTimeout(() => {
			if (!ignore) setSearching(true);
			fetch(`/api/public/schools?q=${encodeURIComponent(q)}`)
				.then((r) => (r.ok ? r.json() : { schools: [] }))
				.then((body: { schools?: PublicSchool[] }) => {
					if (!ignore) setResults(body.schools ?? []);
				})
				.catch(() => {
					if (!ignore) setResults([]);
				})
				.finally(() => {
					if (!ignore) setSearching(false);
				});
		}, 220);
		return () => {
			ignore = true;
			clearTimeout(timer);
		};
	}, [query]);

	// Derived, so a too-short query never needs an effect to clear state.
	const visibleResults = query.trim().length >= 3 ? results : [];

	const submit = useCallback(
		async (intent: "demo" | "self_tour") => {
			setSubmitting(true);
			setError(null);
			try {
				const res = await fetch("/api/public/prospect", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						schoolId: school?.id,
						outreachCode,
						usesSystem,
						contactName,
						phone,
						preferredDay,
						intent,
						website,
					}),
				});
				if (!res.ok) {
					setError(
						"We could not record that just now. Please call or WhatsApp us and we will pick it up.",
					);
					return false;
				}
				setDone(true);
				return true;
			} catch {
				setError(
					"We could not record that just now. Please call or WhatsApp us and we will pick it up.",
				);
				return false;
			} finally {
				setSubmitting(false);
			}
		},
		[school, outreachCode, usesSystem, contactName, phone, preferredDay, website],
	);

	if (done) {
		return (
			<div style={{ textAlign: "center" }}>
				<h1 className="ap-display">Thank you — we have it.</h1>
				<p
					className="ap-lead"
					style={{ marginTop: "var(--ap-md)", color: "var(--ap-ink-80)" }}
				>
					We will call {phone ? phone : "you"} to arrange the demo.
				</p>
				<div style={{ marginTop: "var(--ap-xl)" }}>
					<Link className="ap-btn-ghost" href="/tour">
						Look around while you wait
					</Link>
				</div>
			</div>
		);
	}

	return (
		<div>
			<p className="ap-caption" style={{ color: "var(--ap-ink-48)" }}>
				Step {step} of 4
			</p>

			{/* ---- 1. qualify ------------------------------------------- */}
			{step === 1 ? (
				<div style={{ marginTop: "var(--ap-sm)" }}>
					<h1 className="ap-display">
						Are you using any school management system at the moment?
					</h1>
					<div
						style={{
							display: "flex",
							gap: "var(--ap-sm)",
							marginTop: "var(--ap-xl)",
							flexWrap: "wrap",
						}}
					>
						<button
							className="ap-btn"
							onClick={() => {
								setUsesSystem(true);
								setStep(2);
							}}
							type="button"
						>
							Yes
						</button>
						<button
							className="ap-btn-ghost"
							onClick={() => {
								setUsesSystem(false);
								setStep(2);
							}}
							type="button"
						>
							No
						</button>
					</div>
				</div>
			) : null}

			{/* ---- 2. which school -------------------------------------- */}
			{step === 2 ? (
				<div style={{ marginTop: "var(--ap-sm)" }}>
					<h1 className="ap-display">Which school?</h1>

					{school ? (
						<div className="ap-card" style={{ marginTop: "var(--ap-xl)" }}>
							<p className="ap-body-strong">{school.name}</p>
							<p className="ap-caption" style={{ color: "var(--ap-ink-48)" }}>
								{school.district}, {school.region}
							</p>
							<button
								className="ap-link ap-caption"
								onClick={() => {
									setSchool(null);
									setQuery("");
								}}
								style={{
									background: "none",
									border: 0,
									padding: 0,
									marginTop: "var(--ap-xs)",
									cursor: "pointer",
								}}
								type="button"
							>
								Not your school? Change
							</button>
						</div>
					) : (
						<div style={{ marginTop: "var(--ap-xl)" }}>
							<label className="ap-caption" htmlFor="school-q">
								Start typing the school name
							</label>
							<input
								autoComplete="off"
								className="ap-input"
								id="school-q"
								maxLength={80}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="At least 3 letters"
								value={query}
							/>
							<p className="ap-fine" ref={liveRef} role="status">
								{query.trim().length > 0 && query.trim().length < 3
									? "Keep typing — at least 3 letters."
									: searching
										? "Searching…"
										: query.trim().length >= 3 && visibleResults.length === 0
											? "No match. You can continue without picking one."
											: ""}
							</p>

							{visibleResults.length > 0 ? (
								<ul
									style={{
										listStyle: "none",
										padding: 0,
										marginTop: "var(--ap-xs)",
										display: "grid",
										gap: 2,
									}}
								>
									{visibleResults.map((s) => (
										<li key={s.id}>
											<button
												className="ap-option"
												onClick={() => setSchool(s)}
												type="button"
											>
												<span className="ap-body-strong">{s.name}</span>
												<span
													className="ap-caption"
													style={{ color: "var(--ap-ink-48)" }}
												>
													{s.district}, {s.region}
												</span>
											</button>
										</li>
									))}
								</ul>
							) : null}
						</div>
					)}

					<div
						style={{
							display: "flex",
							gap: "var(--ap-sm)",
							marginTop: "var(--ap-xl)",
						}}
					>
						<button className="ap-btn" onClick={() => setStep(3)} type="button">
							Continue
						</button>
					</div>
				</div>
			) : null}

			{/* ---- 3. the offer ----------------------------------------- */}
			{step === 3 ? (
				<div style={{ marginTop: "var(--ap-sm)" }}>
					<h1 className="ap-display">One price. Everything in it.</h1>
					<p className="ap-hero" style={{ fontSize: 44, marginTop: "var(--ap-md)" }}>
						{fmtTZS(PRICE_TZS)}
					</p>
					<p className="ap-tagline" style={{ color: "var(--ap-ink-48)" }}>
						per year, for the whole school
					</p>
					<p
						className="ap-body"
						style={{ marginTop: "var(--ap-md)", color: "var(--ap-ink-80)" }}
					>
						A school with 500 students pays {fmtTZS(perStudentPerYear)} per
						student per year — about {fmtTZS(perStudentPerMonth)} per student per
						month. The {FREE_SMS.toLocaleString("en-US")} included SMS alone are
						roughly TZS 400,000 to 600,000 of messaging at market rates.
					</p>
					<ul
						style={{
							marginTop: "var(--ap-lg)",
							paddingLeft: "1.2em",
							display: "grid",
							gap: "var(--ap-xxs)",
						}}
					>
						{INCLUSIONS.map((i) => (
							<li className="ap-body" key={i}>
								{i}
							</li>
						))}
					</ul>
					<div style={{ marginTop: "var(--ap-xl)" }}>
						<button className="ap-btn" onClick={() => setStep(4)} type="button">
							Continue
						</button>
					</div>
				</div>
			) : null}

			{/* ---- 4. what next ----------------------------------------- */}
			{step === 4 ? (
				<div style={{ marginTop: "var(--ap-sm)" }}>
					<h1 className="ap-display">What would you like to do?</h1>

					<div className="ap-card" style={{ marginTop: "var(--ap-xl)" }}>
						<p className="ap-tagline">Book a demo</p>
						<p
							className="ap-caption"
							style={{ color: "var(--ap-ink-48)", marginTop: 2 }}
						>
							About 30 minutes, with your own school&apos;s numbers.
						</p>

						<div style={{ display: "grid", gap: "var(--ap-sm)", marginTop: "var(--ap-md)" }}>
							<div>
								<label className="ap-caption" htmlFor="name">
									Your name
								</label>
								<input
									className="ap-input"
									id="name"
									maxLength={120}
									onChange={(e) => setContactName(e.target.value)}
									value={contactName}
								/>
							</div>
							<div>
								<label className="ap-caption" htmlFor="phone">
									Phone number
								</label>
								<input
									className="ap-input"
									id="phone"
									inputMode="tel"
									maxLength={40}
									onChange={(e) => setPhone(e.target.value)}
									placeholder="07XX XXX XXX"
									value={phone}
								/>
							</div>
							<div>
								<label className="ap-caption" htmlFor="day">
									Which day suits you?
								</label>
								<input
									className="ap-input"
									id="day"
									maxLength={40}
									onChange={(e) => setPreferredDay(e.target.value)}
									placeholder="e.g. Tuesday morning"
									value={preferredDay}
								/>
							</div>

							{/* honeypot — visually hidden, never filled by a person */}
							<input
								aria-hidden="true"
								autoComplete="off"
								onChange={(e) => setWebsite(e.target.value)}
								style={{
									position: "absolute",
									left: "-9999px",
									width: 1,
									height: 1,
								}}
								tabIndex={-1}
								value={website}
							/>
						</div>

						{error ? (
							<p
								className="ap-caption"
								role="alert"
								style={{ color: "#cf202f", marginTop: "var(--ap-sm)" }}
							>
								{error}
							</p>
						) : null}

						<button
							className="ap-btn"
							disabled={submitting || phone.trim().length < 9}
							onClick={() => void submit("demo")}
							style={{ marginTop: "var(--ap-md)" }}
							type="button"
						>
							{submitting ? "Sending…" : "Book the demo"}
						</button>
					</div>

					<div className="ap-card" style={{ marginTop: "var(--ap-lg)" }}>
						<p className="ap-tagline">Look around on my own</p>
						<p
							className="ap-caption"
							style={{ color: "var(--ap-ink-48)", marginTop: 2 }}
						>
							Real screens, no sign-in, no commitment.
						</p>
						<Link
							className="ap-btn-ghost"
							href="/tour"
							onClick={() => void submit("self_tour")}
							style={{ marginTop: "var(--ap-md)" }}
						>
							Take the tour
						</Link>
					</div>
				</div>
			) : null}

			{step > 1 && !done ? (
				<button
					className="ap-link ap-caption"
					onClick={() => setStep((s) => s - 1)}
					style={{
						background: "none",
						border: 0,
						padding: 0,
						marginTop: "var(--ap-xl)",
						cursor: "pointer",
					}}
					type="button"
				>
					← Back
				</button>
			) : null}
		</div>
	);
}
