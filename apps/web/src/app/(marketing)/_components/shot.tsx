import Image from "next/image";

/**
 * A real product screen framed as a browser window, never a stock
 * illustration.
 *
 * Where a capture does not exist yet, a labelled placeholder holds the right
 * aspect ratio so the layout is final and only the pixels are outstanding.
 * `needs` names the exact screen to capture.
 *
 * That placeholder is a note to ourselves, so it renders in development ONLY.
 * A grey box reading "Screenshot pending" went out on the live landing page,
 * where it says to a head teacher that the screen does not exist. In
 * production the slot collapses instead and the surrounding copy carries the
 * stop on its own.
 */
export function AppWindow({
	src,
	alt,
	needs,
	caption,
	priority = false,
	width = 2400,
	height = 1500,
}: {
	src?: string;
	alt: string;
	/** The screen this slot needs, e.g. "/finance/debtors as a bursar". */
	needs?: string;
	caption?: string;
	priority?: boolean;
	width?: number;
	height?: number;
}) {
	if (!src && process.env.NODE_ENV === "production") return null;

	return (
		<figure style={{ margin: 0 }}>
			<div className="ap-window">
				<div className="ap-window-bar">
					<span className="ap-window-dot" />
					<span className="ap-window-dot" />
					<span className="ap-window-dot" />
				</div>
				{src ? (
					<Image
						alt={alt}
						height={height}
						priority={priority}
						sizes="(max-width: 834px) 100vw, 980px"
						src={src}
						width={width}
					/>
				) : (
					<div
						className="ap-window-body"
						style={{
							aspectRatio: `${width} / ${height}`,
							background: "var(--ap-parchment)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							padding: "var(--ap-lg)",
							textAlign: "center",
						}}
					>
						<span className="ap-caption" style={{ color: "var(--ap-ink-48)" }}>
							Screenshot pending{needs ? `: ${needs}` : ""}
						</span>
					</div>
				)}
			</div>
			{caption ? (
				<figcaption
					className="ap-caption"
					style={{
						marginTop: "var(--ap-sm)",
						color: "var(--ap-ink-48)",
						textAlign: "center",
					}}
				>
					{caption}
				</figcaption>
			) : null}
		</figure>
	);
}
