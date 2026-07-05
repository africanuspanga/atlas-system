import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh + route protection.
 * Unauthenticated users are sent to /login; authenticated users never see
 * /login again. Onboarding enforcement (no tenant yet) happens server-side
 * in the pages themselves.
 */
export async function proxy(request: NextRequest) {
	let response = NextResponse.next({ request });

	const supabase = createServerClient(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
		{
			cookies: {
				getAll() {
					return request.cookies.getAll();
				},
				setAll(cookiesToSet) {
					for (const { name, value } of cookiesToSet) {
						request.cookies.set(name, value);
					}
					response = NextResponse.next({ request });
					for (const { name, value, options } of cookiesToSet) {
						response.cookies.set(name, value, options);
					}
				},
			},
		},
	);

	// Do not run code between createServerClient and auth.getUser().
	const {
		data: { user },
	} = await supabase.auth.getUser();

	const path = request.nextUrl.pathname;
	const isPublic = path.startsWith("/login") || path.startsWith("/auth");

	if (!user && !isPublic) {
		const url = request.nextUrl.clone();
		url.pathname = "/login";
		url.search = path !== "/" ? `?next=${encodeURIComponent(path)}` : "";
		return NextResponse.redirect(url);
	}
	if (user && path.startsWith("/login")) {
		const url = request.nextUrl.clone();
		url.pathname = "/";
		return NextResponse.redirect(url);
	}

	return response;
}

export const config = {
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
	],
};
