/**
 * Session-scoped thread identity.
 *
 * The problem this solves: a run's sandbox container is pinned to its
 * `threadId` (see `namedCloudflareSandbox`), and every container is injected
 * with this app's `ANTHROPIC_API_KEY`. So whoever can name a `threadId` can
 * reach that container — its workspace, its files, and its credentials. If the
 * browser were allowed to send a `threadId` of its choosing, one visitor could
 * address another's container simply by reusing or guessing the value.
 *
 * The fix is to make a thread id underivable by anyone but its owner, without
 * requiring a login or any stored state:
 *
 *   sessionId  — 256 bits of randomness, set as an HttpOnly cookie. Opaque: the
 *                server stores nothing and verifies nothing, because there is
 *                nothing to forge. A fabricated value is simply a different
 *                (empty) namespace, which is harmless.
 *   threadKey  — chosen by the client, one per chat thread. Not a secret.
 *   threadId   — SHA-256(sessionId, threadKey).
 *
 * Two visitors who pick the same `threadKey` still get different `threadId`s,
 * and reaching someone else's thread means guessing their 256-bit session id.
 *
 * Hashing rather than concatenating matters: the `threadId` becomes a container
 * Durable Object name and appears in R2 keys and the run log, so it must not
 * carry the session id in recoverable form.
 *
 * This is scoping, not authentication — it establishes that two browsers are
 * different tenants, not who they are. When real accounts arrive, derive the
 * session id from the authenticated user instead and the rest holds.
 */

export const SESSION_COOKIE = 'hf_session'

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
 * Returns `null` for anything that is not exactly the shape we issue, so a
 * malformed or injected value can never become a namespace. Parsing is
 * deliberately strict rather than lenient: this value seeds a container name.
 */
export function readSessionId(request: Request): string | null {
  const header = request.headers.get('cookie')
  if (header === null) return null

  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) continue
    const name = part.slice(0, separator).trim()
    if (name !== SESSION_COOKIE) continue
    const value = part.slice(separator + 1).trim()
    return SESSION_ID_PATTERN.test(value) ? value : null
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
    `${SESSION_COOKIE}=${sessionId}`,
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

/**
 * Derive the real thread id. NEVER use a client-supplied value directly as a
 * thread id — that is the whole point of this module.
 */
export async function deriveThreadId(
  sessionId: string,
  threadKey: string,
): Promise<string> {
  // A NUL separator keeps the encoding unambiguous: without it ("ab","c") and
  // ("a","bc") would hash identically. Written as the ESCAPE \0, never a literal
  // NUL byte -- a raw NUL makes the file binary to grep and invisible in editors.
  const encoded = new TextEncoder().encode(`${sessionId}\0${threadKey}`)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return toHex(digest)
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
