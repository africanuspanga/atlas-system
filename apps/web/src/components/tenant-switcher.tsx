"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { VisibleTenant } from "@/lib/active-tenant";
import { getDict } from "@/i18n";

export function TenantSwitcher({
	tenants,
	activeTenantId,
}: {
	tenants: VisibleTenant[];
	activeTenantId?: string;
}) {
	const router = useRouter();
	const t = getDict();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (tenants.length < 2) return null;

	return (
		<label className="flex items-center gap-2 text-xs text-muted-foreground">
			<span className="sr-only">Active School</span>
			<select
				aria-label="Active School"
				className="max-w-48 rounded-md border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				disabled={pending}
				value={activeTenantId ?? tenants[0]?.id}
				onChange={async (event) => {
					setPending(true);
					setError(null);
					try {
						const response = await fetch("/api/tenant", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ tenantId: event.target.value }),
						});
						if (!response.ok) throw new Error("TENANT_SWITCH_FAILED");
						router.refresh();
					} catch {
						setError(t("common.apiUnreachable"));
					} finally {
						setPending(false);
					}
				}}
			>
				{tenants.map((tenant) => (
					<option key={tenant.id} value={tenant.id}>
						{tenant.name}
					</option>
				))}
			</select>
			{error && (
				<span className="text-destructive" role="status">
					{error}
				</span>
			)}
		</label>
	);
}
