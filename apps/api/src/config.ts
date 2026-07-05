/**
 * Central config resolution with fail-fast validation. The web origin is used
 * both for CORS and for building invitation links that get emailed/copied to
 * real users — so in production it MUST be set to the real domain. A silent
 * localhost fallback there would mail broken invite links (AUD-005).
 */
export function resolveWebOrigin(): string {
  const origin = process.env.WEB_ORIGIN;
  if (!origin) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'WEB_ORIGIN must be set in production — it builds invitation links and the CORS allowlist.',
      );
    }
    return 'http://localhost:3000';
  }
  return origin.replace(/\/$/, '');
}
