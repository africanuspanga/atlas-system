/**
 * Contour lines, as a decorative field.
 *
 * An atlas is a book of maps and the ATLAS mark is a peak, so the pattern the
 * brand is drawn in is the one an atlas is actually made of. Contours also
 * behave where blobs and gradients do not: they are thin strokes at a few
 * percent opacity, so copy sits on top of them without losing contrast.
 *
 * Deliberately NOT scoped to either design system. It takes its colours as
 * props and holds no tokens of its own, so the product surface can pass Atlas
 * Blue and the marketing surface can pass its own without either one reaching
 * into the other's stylesheet.
 */

const LINE_COUNT = 26;

/**
 * One contour. The lines crowd and spread the way real contours do on a slope,
 * which is what stops an evenly spaced set from reading as a barcode.
 */
function contourPath(i: number): string {
	const y = 24 + i * 36 + Math.sin(i * 0.62) * 16;
	const amp = 32 + Math.sin(i * 0.9) * 18;
	const drift = Math.sin(i * 0.35) * 70;

	return [
		`M -90 ${y.toFixed(1)}`,
		`C ${(150 + drift).toFixed(1)} ${(y - amp).toFixed(1)},`,
		`${(310 - drift).toFixed(1)} ${(y + amp).toFixed(1)},`,
		`${(450 + drift * 0.4).toFixed(1)} ${(y - amp * 0.35).toFixed(1)}`,
		`S ${(700 - drift).toFixed(1)} ${(y + amp * 0.85).toFixed(1)},`,
		`940 ${(y - amp * 0.25).toFixed(1)}`,
	].join(" ");
}

export function ContourField({
	accent,
	className,
	fade = "#ffffff",
	ink = "#0a0b0d",
	/** Every nth line is drawn in the accent instead of the ink. */
	accentEvery = 3,
}: {
	/** The brand blue. Omit for an ink-only field. */
	accent?: string;
	className?: string;
	/** Surface colour, used to soften the top and bottom edges. */
	fade?: string;
	ink?: string;
	accentEvery?: number;
}) {
	const gradientId = `atlas-contour-fade-${ink.replace("#", "")}`;

	return (
		<svg
			aria-hidden="true"
			className={className}
			preserveAspectRatio="xMidYMid slice"
			viewBox="0 0 850 1000"
		>
			<defs>
				{/* Lifts the pattern off the top and bottom edges so headings and
				    footer links sit on clean paper. */}
				<linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
					<stop offset="0%" stopColor={fade} stopOpacity="0.95" />
					<stop offset="22%" stopColor={fade} stopOpacity="0" />
					<stop offset="78%" stopColor={fade} stopOpacity="0" />
					<stop offset="100%" stopColor={fade} stopOpacity="0.95" />
				</linearGradient>
			</defs>

			<g fill="none" strokeWidth="1">
				{Array.from({ length: LINE_COUNT }, (_, i) => {
					const isAccent = accent !== undefined && i % accentEvery === 0;
					return (
						<path
							d={contourPath(i)}
							key={i}
							stroke={isAccent ? accent : ink}
							strokeOpacity={(
								(isAccent ? 0.1 : 0.04) +
								(Math.sin(i * 1.3) + 1) * 0.021
							).toFixed(3)}
						/>
					);
				})}
			</g>

			<rect fill={`url(#${gradientId})`} height="1000" width="850" x="0" y="0" />
		</svg>
	);
}
