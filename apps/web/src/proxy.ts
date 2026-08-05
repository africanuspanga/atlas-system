import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
	APP_HOME,
	APP_ORIGIN,
	MARKETING_ORIGIN,
	isMarketingPath,
	isPublicPath,
	isSharedPath,
	normalisePath,
	surfaceForHost,
} from "@/lib/hosts";

/**
 * Host split, then session refresh + route protection.
 *
 * The host decision runs FIRST, before any auth or database work, so a request
 * that landed on the wrong host does not also pay for a session round trip.
 *
 * Redirects are 307, never 308: a permanent redirect is cached by the browser
 * for as long as it likes, so getting the split wrong once would follow
 * visitors around for months.
 *
 * Cross-host links in components must be plain <a> built with appHref() /
 * marketingHref() — a client-side <Link> to the other surface is just 307'd
 * straight back out.
 */
export async function proxy(request: NextRequest) {
	const rawPath = request.nextUrl.pathname;
	const surface = surfaceForHost(request.headers.get("host"));

	// Judge on a NORMALISED copy so `/blog/%2e%2e/dashboard` is treated as the
	// app path the router will really serve, not as marketing. Redirect with the
	// RAW path, because normalising lowercases and a case-sensitive slug 404s.
	const judged = normalisePath(rawPath);
	const shared = isSharedPath(judged);
	const marketing = isMarketingPath(judged);

	if (surface !== "combined" && !shared) {
		// Never build the target by string concatenation: new URL("//evil.tz",
		// origin) resolves to https://evil.tz. Assigning pathname onto a URL
		// object cannot change the host.
		const redirectTo = (origin: string) => {
			const target = new URL(origin);
			target.pathname = rawPath;
			target.search = request.nextUrl.search;
			return NextResponse.redirect(target, 307);
		};

		if (surface === "app") {
			// Somebody typing the bare app host wants to get in, not read the pitch.
			if (judged === "/") {
				const target = new URL(APP_ORIGIN);
				target.pathname = "/login";
				return NextResponse.redirect(target, 307);
			}
			if (marketing) return redirectTo(MARKETING_ORIGIN);
		}

		if (surface === "marketing" && !marketing) return redirectTo(APP_ORIGIN);
	}

	// Marketing and shared routes are anonymous by definition. Returning before
	// the Supabase call keeps the funnel alive when the database is asleep, and
	// stops the landing page from ever 401ing the visitors it exists to serve.
	if (marketing || shared) return NextResponse.next({ request });

	let response = NextResponse.next({ request });
	let applyRotatedCookies = (target: NextResponse) => target;

	const supabase = createServerClient(
		process.env.NEXT_PUBLIC_SUPABASE_URL!,
		process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
		{
			cookies: {
				getAll() {
					return request.cookies.getAll();
				},
				setAll(cookiesToSet) {
					applyRotatedCookies = (target) => {
						for (const { name, value, options } of cookiesToSet) {
							target.cookies.set(name, value, options);
						}
						return target;
					};
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

	if (!user && !isPublicPath(judged)) {
		const url = request.nextUrl.clone();
		url.pathname = "/login";
		url.search = `?next=${encodeURIComponent(rawPath)}`;
		return applyRotatedCookies(NextResponse.redirect(url));
	}
	if (user && judged.startsWith("/login")) {
		const url = request.nextUrl.clone();
		url.pathname = APP_HOME;
		url.search = "";
		return applyRotatedCookies(NextResponse.redirect(url));
	}

	return response;
}

export const config = {
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
	],
};
