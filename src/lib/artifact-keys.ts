/**
 * The public key space, and the guard that keeps everything else private.
 *
 * `RENDERS` holds three different things: published renders, published
 * compositions, and short-lived upload tickets. Only the first two are public.
 * The `/r/*` and `/p/*` routes take their key from the URL, so without an
 * explicit allowlist they would happily serve `tickets/<runId>/<name>` — whose
 * body contains a live bearer token. `runId` is a server-generated UUID, but it
 * is NOT a secret: it goes back to the browser in the run trigger response and
 * rides the SSE stream, so treating it as one would be wrong.
 *
 * Hence: each route declares the single prefix it serves, and anything else is
 * a 404. The prefix is not taken from the request.
 */

/** Published composition HTML — served by `/p/*`. */
export const PREVIEW_PREFIX = 'previews/'

/** Published renders — served by `/r/*`. */
export const RENDER_PREFIX = 'renders/'

/** Upload tickets. Deliberately absent from every public route. */
export const TICKET_PREFIX = 'tickets/'

/**
 * R2 keys are opaque strings, so `..` has no traversal meaning to R2 itself —
 * but rejecting it keeps the key space legible and stops a key from resolving
 * somewhere a human reading a log would not expect.
 */
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/u

/**
 * Validate a URL-supplied R2 key against the one prefix a route is allowed to
 * serve. Returns the key when it is servable, or `null` — which every caller
 * turns into an indistinguishable 404.
 */
export function servableKey(
  splat: string | undefined,
  prefix: string,
): string | null {
  if (splat === undefined || splat === '') return null
  if (!splat.startsWith(prefix)) return null
  if (splat.includes('..')) return null
  if (!SAFE_KEY.test(splat)) return null
  return splat
}
