import { createClient } from "@/lib/supabase/client";

/** Client-side helper: authenticated ATLAS API call with tenant context. */
export async function apiFetch(
	path: string,
	options: RequestInit & { tenantId?: string } = {},
) {
	const { tenantId, ...init } = options;
	const supabase = createClient();
	const {
		data: { session },
	} = await supabase.auth.getSession();

	return fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
			...(tenantId ? { "x-tenant-id": tenantId } : {}),
			...(init.headers ?? {}),
		},
	});
}
