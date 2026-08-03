import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

export const ACTIVE_TENANT_COOKIE = "atlas_active_tenant";

export interface VisibleTenant {
	id: string;
	name: string;
	status: string;
}

/** Resolve one deterministic, user-authorized school across every web page. */
export async function getActiveTenants(supabase: SupabaseClient): Promise<{
	data: VisibleTenant[] | null;
	all: VisibleTenant[];
	error: unknown;
}> {
	const { data, error } = await supabase
		.from("tenants")
		.select("id, name, status")
		.neq("status", "archived")
		.order("created_at", { ascending: true });
	if (error) return { data: null, all: [], error };

	const all = (data ?? []) as VisibleTenant[];
	const selectedId = (await cookies()).get(ACTIVE_TENANT_COOKIE)?.value;
	const selected = all.find((tenant) => tenant.id === selectedId) ?? all[0];
	return { data: selected ? [selected] : [], all, error: null };
}
