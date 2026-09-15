import { Suspense } from "react";
import { ContourField } from "@/components/contour-field";
import { LoginForm } from "./login-form";
import { LoginShowcase } from "./showcase";

export const metadata = {
	title: "Sign in",
	description: "Sign in to ATLAS, or open the demo school and look around.",
};

/**
 * Two panels: the form on the left, the product on the right.
 *
 * White throughout and deliberately light-locked, so the page reads the same
 * whether or not the visitor has dark mode on. `atlas-light-lock` in
 * globals.css is what pins the palette; remove that one class to hand the page
 * back to the theme toggle.
 *
 * The contour field is on the form side ONLY. Behind the screenshots it fought
 * them: two patterns in one frame, and the one that mattered was the product.
 * On the form side it gives the page its texture and the screenshots keep a
 * clean sheet of paper to sit on.
 *
 * The showcase drops out entirely below lg. Most Tanzanian school staff reach
 * this on a phone, and a decorative half-screen above the form there would
 * push the only thing they came for below the fold.
 */
export default async function LoginPage() {
	return (
		<div className="atlas-light-lock grid min-h-svh bg-background lg:grid-cols-2">
			<div className="relative isolate flex justify-center overflow-hidden px-6 py-12 sm:px-10 lg:items-center lg:px-14">
				<ContourField
					accent="#0052ff"
					className="pointer-events-none absolute inset-0 -z-10 h-full w-full"
				/>
				<Suspense>
					<LoginForm />
				</Suspense>
			</div>
			<LoginShowcase />
		</div>
	);
}
