/**
 * Returns a safe internal redirect target, or the fallback. Rejects anything
 * that could leave the app: absolute URLs, protocol-relative `//host`, and
 * backslash variants some browsers normalise to `//`. Only same-origin
 * absolute paths ("/students", "/portal?x=1") are allowed.
 */
export function safeNext(value: string | null | undefined, fallback = "/"): string {
	if (!value) return fallback;
	// must start with a single slash, and the second char must not be / or \
	if (!value.startsWith("/")) return fallback;
	if (value.length > 1 && (value[1] === "/" || value[1] === "\\")) return fallback;
	// no control chars or whitespace that could confuse a browser
	if (/[\x00-\x1f\x7f]/.test(value)) return fallback;
	return value;
}
