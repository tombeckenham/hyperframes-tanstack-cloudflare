/**
 * Session-scoped thread identity.
 *
 * The problem this solves: a run's sandbox container is pinned to its
 * `threadId` (see `namedCloudflareSandbox`), and every container is injected
 * with this app's harness API key. So whoever can name a `threadId` can
 * reach that container — its workspace, its files, and its credentials. If the
 * browser were allowed to send a `threadId` of its choosing, one visitor could
 * address another's container simply by reusing or guessing the value.
 *
 * The fix is to make a thread id underivable by anyone but its owner, without
 * requiring a login or any stored state:
 *
 *   sessionId  — 256 bits of randomness, set as an HttpOnly cookie. Opaque: the
 *                server stores nothing and verifies nothing about it.
 *   threadKey  — chosen by the client, one per chat thread. Not a secret.
 *   threadId   — SHA-256(sessionId \0 threadKey), truncated to 128 bits so the
 *                id fits the sandbox container's 63-char (DNS label) ID limit.
 *
 * Two visitors who pick the same `threadKey` still get different `threadId`s,
 * and reaching someone else's thread means guessing their 256-bit session id
 * (or the 128-bit thread id itself — either is out of reach).
 *
 * Hashing rather than concatenating matters: the `threadId` becomes a container
 * Durable Object name and appears in R2 keys and the run log, so it must not
 * carry the session id in recoverable form.
 *
 * SESSION FIXATION — the cookie is unsigned, so it is worth being precise about
 * what that does and does not cost. An attacker inventing a value FOR THEMSELVES
 * gains nothing: they get a different, empty namespace. The real vector is
 * planting a well-formed value in the VICTIM's browser, which would land the
 * victim's runs in the attacker's namespace — same container, same API key, same
 * R2 prefixes. Rejecting malformed cookies does not help, because a planted
 * value is well-formed by construction.
 *
 * The defense is the `__Host-` prefix: browsers refuse such a cookie unless it
 * is `Secure`, `Path=/`, and carries NO `Domain`, which makes it unwritable from
 * a sibling or parent domain — the usual way a cookie gets planted. So the name
 * is `__Host-hf_session` over https, falling back to the bare name on http
 * because `__Host-` requires `Secure` and local dev is plain http.
 *
 * Two in-app vectors are already closed by design rather than by luck: previews
 * are served on `*.trycloudflare.com` (a different site entirely), and `/p/*`
 * serves LLM-authored HTML under `sandbox allow-scripts`, i.e. an opaque origin
 * with no `document.cookie` at all.
 *
 * This is tenant scoping, not authentication — it establishes that two browsers
 * are different tenants, not who they are. When real accounts arrive, derive the
 * session id from the authenticated user instead and the rest holds.
 */

/**
 * Cookie name on https. The `__Host-` prefix is enforced by the browser: it
 * refuses to store one that is not Secure + Path=/ + Domain-less, which is
 * exactly what stops a subdomain from planting a session.
 */
export const SESSION_COOKIE_SECURE = '__Host-hf_session'

/** Fallback for plain-http local dev, where `__Host-` cannot be used. */
export const SESSION_COOKIE = 'hf_session'

/** The names we accept, most-preferred first. */
const SESSION_COOKIE_NAMES = [SESSION_COOKIE_SECURE, SESSION_COOKIE] as const

/** A year. The cookie is the only handle a visitor has on their own threads. */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

/** 32 bytes, hex — the same shape `readSessionId` will accept back. */
const SESSION_ID_PATTERN = /^[0-9a-f]{64}$/u

const toHex = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return Array.from(view, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function createSessionId(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return toHex(bytes)
}

/**
 * Read our session cookie out of a request.
 *
 * Ignores anything that is not exactly the shape we issue, so a malformed or
 * injected value can never become a namespace. Parsing is deliberately strict
 * rather than lenient: this value seeds a container name.
 *
 * A bad value is SKIPPED, not treated as "no cookie found" — a header may carry
 * the same name twice (that is what a Domain- or Path-scoped overwrite looks
 * like), and bailing on the first match would silently discard a visitor's real
 * session and orphan every thread they had.
 *
 * `__Host-` wins over the bare name when both are present: it is the one a
 * subdomain cannot have written.
 */
export function readSessionId(request: Request): string | null {
  const header = request.headers.get('cookie')
  if (header === null) return null

  const found = new Map<string, string>()

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    const name = part.slice(0, separator).trim()
    if (!SESSION_COOKIE_NAMES.some((candidate) => candidate === name)) continue
    const value = part.slice(separator + 1).trim()
    if (!SESSION_ID_PATTERN.test(value)) continue
    if (!found.has(name)) found.set(name, value)
  }

  for (const name of SESSION_COOKIE_NAMES) {
    const value = found.get(name)
    if (value !== undefined) return value
  }

  return null
}

/**
 * Serialise the session cookie.
 *
 * `HttpOnly` is the load-bearing attribute: it keeps the value away from
 * document scripts, which matters because this app deliberately serves
 * LLM-authored HTML. `SameSite=Lax` withholds the cookie from cross-site POSTs,
 * so a third-party page cannot start runs in a visitor's namespace.
 *
 * `Secure` is set for https only — otherwise the cookie is silently dropped on
 * a plain-http local dev server.
 */
export function serialiseSessionCookie(
  sessionId: string,
  { secure }: { secure: boolean },
): string {
  const attributes = [
    `${secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ]
  if (secure) attributes.push('Secure')
  return attributes.join('; ')
}

/** True when the request reached us over https (behind Cloudflare, or direct). */
export const isSecureRequest = (request: Request): boolean =>
  new URL(request.url).protocol === 'https:'

declare const threadIdBrand: unique symbol

/**
 * A thread id that provably came from {@link deriveThreadId}.
 *
 * Branded on purpose. The invariant "never use a client-supplied threadId" is
 * the only thing standing between one visitor and another's container, and a
 * comment cannot enforce it. Because a raw `string` is not assignable to
 * `ThreadId`, a call site that reaches for `body.threadId` fails to compile
 * instead of shipping.
 */
export type ThreadId = string & { readonly [threadIdBrand]: true }

/**
 * The derived id is the SHA-256 hex TRUNCATED to 32 chars (128 bits). Full
 * SHA-256 hex is 64 chars, and the id becomes the sandbox container's ID,
 * which `@cloudflare/sandbox` caps at 63 (a DNS label) — the full digest is
 * rejected at the first `getSandbox()` call, i.e. only once a real run starts.
 * 128 bits keeps the id unguessable (the underlying session id is still the
 * full 256 bits) and cross-tenant collisions are a birthday problem at 2^64.
 */
const THREAD_ID_HEX_CHARS = 32

/**
 * Derive the real thread id. NEVER use a client-supplied value directly as a
 * thread id — that is the whole point of this module.
 */
export async function deriveThreadId(
  sessionId: string,
  threadKey: string,
): Promise<ThreadId> {
  // A NUL separator keeps the encoding unambiguous: without it ("ab","c") and
  // ("a","bc") would hash identically. Written as the ESCAPE \0, never a literal
  // NUL byte -- a raw NUL makes the file binary to grep and invisible in editors.
  const encoded = new TextEncoder().encode(`${sessionId}\0${threadKey}`)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  // The sole place the brand is applied: everything else must obtain a ThreadId
  // by calling this function.
  return toHex(digest).slice(0, THREAD_ID_HEX_CHARS) as ThreadId
}

/**
 * Resolve the session for a request, minting one when absent.
 *
 * `setCookie` is non-null only when a new session was created, so callers
 * attach it to the response exactly when there is something to persist.
 */
export function resolveSession(request: Request): {
  sessionId: string
  setCookie: string | null
} {
  const existing = readSessionId(request)
  if (existing !== null) return { sessionId: existing, setCookie: null }

  const sessionId = createSessionId()
  return {
    sessionId,
    setCookie: serialiseSessionCookie(sessionId, {
      secure: isSecureRequest(request),
    }),
  }
}
