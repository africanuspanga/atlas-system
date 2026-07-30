import { cn } from "@/lib/utils";

/** Shared loading placeholder for module list views (pre-`loaded`). */
export function ListSkeleton({
	rows = 6,
	className,
}: {
	rows?: number;
	className?: string;
}) {
	return (
		<div
			aria-hidden
			className={cn("flex flex-col gap-2 rounded-xl border p-4", className)}
		>
			<div className="h-5 w-1/3 animate-pulse rounded-full bg-muted" />
			{Array.from({ length: rows }, (_, index) => (
				<div
					className="h-9 w-full animate-pulse rounded-lg bg-muted"
					key={`skeleton-row-${index}`}
				/>
			))}
		</div>
	);
}
