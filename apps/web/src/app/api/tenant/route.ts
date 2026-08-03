import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_TENANT_COOKIE } from "@/lib/active-tenant";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
	const body = (await request.json().catch(() => null)) as {
		tenantId?: unknown;
	} | null;
	if (typeof body?.tenantId !== "string" || !UUID_RE.test(body.tenantId)) {
		return NextResponse.json({ code: "INVALID_TENANT" }, { status: 400 });
	}

	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) {
		return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
	}
	const { data: tenant, error } = await supabase
		.from("tenants")
		.select("id")
		.eq("id", body.tenantId)
		.neq("status", "archived")
		.maybeSingle();
	if (error) {
		return NextResponse.json({ code: "TENANT_LOOKUP_FAILED" }, { status: 500 });
	}
	if (!tenant) {
		return NextResponse.json({ code: "TENANT_FORBIDDEN" }, { status: 403 });
	}

	(await cookies()).set(ACTIVE_TENANT_COOKIE, body.tenantId, {
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: 365 * 24 * 60 * 60,
	});
	return NextResponse.json({ tenantId: body.tenantId });
}
