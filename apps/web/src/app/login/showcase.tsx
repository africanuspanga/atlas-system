"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { getDict } from "@/i18n";

/**
 * The right half of the sign-in screen.
 *
 * Real product screens rather than an illustration, and rather than testimonial
 * quotes: ATLAS has no schools live yet, so there is nobody to quote. Three
 * captures already exist in /public/screenshots and they are the most honest
 * thing that can sit here.
 *
 * The panel is white, on the contour backdrop the whole page shares. Blue is
 * the one action colour and design.md keeps it to a moment or two per view,
 * which on this screen is the sign-in button and the active dot, so the panel
 * earns its separation from a hairline and the pattern instead of a colour
 * flood. Light UI screenshots also sit more honestly on paper than on a tinted
 * ground: what you see here is what the product looks like.
 */
const SLIDES = [
	{
		src: "/screenshots/dashboard.png",
		titleKey: "login.slideDashboardTitle",
		bodyKey: "login.slideDashboardBody",
	},
	{
		src: "/screenshots/debtors.png",
		titleKey: "login.slideDebtorsTitle",
		bodyKey: "login.slideDebtorsBody",
	},
	{
		src: "/screenshots/students.png",
		titleKey: "login.slideStudentsTitle",
		bodyKey: "login.slideStudentsBody",
	},
] as const;

const INTERVAL_MS = 6000;

export function LoginShowcase() {
	const t = getDict();
	const [index, setIndex] = useState(0);
	const [paused, setPaused] = useState(false);

	useEffect(() => {
		// Anyone who has asked their system to stop moving things gets a static
		// first slide and the dots to move it themselves.
		const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
		if (paused || reduced.matches) return;
		const timer = setInterval(
			() => setIndex((i) => (i + 1) % SLIDES.length),
			INTERVAL_MS,
		);
		return () => clearInterval(timer);
	}, [paused]);

	return (
		<div
			className="relative hidden flex-col justify-center gap-10 overflow-hidden border-border p-10 lg:flex lg:border-l xl:p-14"
			onBlur={() => setPaused(false)}
			onFocus={() => setPaused(true)}
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
		>
			<p className="max-w-sm text-2xl tracking-tight text-muted-foreground">
				{t("login.showcaseHeading")}
			</p>

			{/* The stack is absolutely positioned so the panel never changes height
			    between slides — a jumping panel next to a form is the fastest way to
			    make someone lose their place in it. */}
			<div className="relative aspect-[1568/675] w-full">
				{SLIDES.map((slide, i) => (
					<div
						aria-hidden={i !== index}
						className={`absolute inset-0 overflow-hidden rounded-xl border border-border bg-card transition-opacity duration-700 ${
							i === index ? "opacity-100" : "opacity-0"
						}`}
						key={slide.src}
					>
						<Image
							alt={t(slide.titleKey)}
							className="h-full w-full object-cover object-top"
							height={675}
							priority={i === 0}
							sizes="50vw"
							src={slide.src}
							width={1568}
						/>
					</div>
				))}
			</div>

			<div>
				{/* The captions cross-fade on the same curve as the images. Swapping
				    the text instantly left the old screenshot sitting under the new
				    caption for the length of the fade, which reads as a mismatch. */}
				<div className="relative h-20">
					{SLIDES.map((slide, i) => (
						<div
							aria-hidden={i !== index}
							className={`absolute inset-0 transition-opacity duration-700 ${
								i === index ? "opacity-100" : "opacity-0"
							}`}
							key={slide.src}
						>
							<p className="text-xl tracking-tight">{t(slide.titleKey)}</p>
							<p className="mt-2 max-w-md text-sm text-muted-foreground">
								{t(slide.bodyKey)}
							</p>
						</div>
					))}
				</div>

				<div className="mt-5 flex gap-2">
					{SLIDES.map((slide, i) => (
						<button
							aria-current={i === index}
							aria-label={`${t("login.goToSlide")} ${i + 1}`}
							className={`h-2 rounded-full transition-all focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary ${
								i === index
									? "w-8 bg-primary"
									: "w-2 bg-foreground/20 hover:bg-foreground/35"
							}`}
							key={slide.src}
							onClick={() => setIndex(i)}
							type="button"
						/>
					))}
				</div>
			</div>
		</div>
	);
}
