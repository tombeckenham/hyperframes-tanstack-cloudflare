import { expect, test } from 'bun:test'
import {
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
  createSessionId,
  deriveThreadId,
  readSessionId,
  resolveSession,
  serialiseSessionCookie,
} from './session'

const HEX_64 = /^[0-9a-f]{64}$/u

const withCookie = (cookie: string, url = 'https://studio.example/api/run') =>
  new Request(url, { headers: { cookie } })

test('a session id is 256 bits of hex', () => {
  expect(createSessionId()).toMatch(HEX_64)
})

test('session ids are not repeated', () => {
  const ids = new Set(Array.from({ length: 200 }, () => createSessionId()))
  expect(ids.size).toBe(200)
})

test('reads our cookie out of a crowded header', () => {
  const id = createSessionId()
  const request = withCookie(`other=1; ${SESSION_COOKIE}=${id}; another=x`)
  expect(readSessionId(request)).toBe(id)
})

test('rejects a malformed cookie rather than trusting it', () => {
  // This value seeds a container name, so anything that is not exactly the
  // shape we issue must be discarded — not sanitised, not accepted.
  const bad = [
    'not-hex',
    'ABCDEF',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    '../../etc/passwd',
    '',
  ]
  for (const value of bad) {
    expect(readSessionId(withCookie(`${SESSION_COOKIE}=${value}`))).toBeNull()
  }
})

test('a malformed cookie is skipped, not treated as the final answer', () => {
  // A header can carry the same name twice — that is what a Domain- or
  // Path-scoped overwrite looks like. Bailing on the first match would discard
  // the visitor's real session and orphan every thread they had.
  const id = createSessionId()
  const request = withCookie(`${SESSION_COOKIE}=junk; ${SESSION_COOKIE}=${id}`)
  expect(readSessionId(request)).toBe(id)
})

test('__Host- cookie wins over the bare name when both are present', () => {
  // The prefixed one is the cookie a sibling domain cannot have written.
  const planted = createSessionId()
  const genuine = createSessionId()
  const request = withCookie(
    `${SESSION_COOKIE}=${planted}; ${SESSION_COOKIE_SECURE}=${genuine}`,
  )
  expect(readSessionId(request)).toBe(genuine)
})

test('missing cookie header is null, not a throw', () => {
  expect(readSessionId(new Request('https://studio.example/'))).toBeNull()
})

test('https cookie uses the __Host- prefix and its required attributes', () => {
  // __Host- is what stops a subdomain planting a session. Browsers enforce it
  // only when the cookie is Secure, Path=/, and carries no Domain.
  const cookie = serialiseSessionCookie(createSessionId(), { secure: true })
  expect(cookie).toContain(`${SESSION_COOKIE_SECURE}=`)
  expect(cookie).toContain('Secure')
  expect(cookie).toContain('Path=/')
  expect(cookie).not.toContain('Domain=')
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')
})

test('http falls back to the bare name so local dev is not silently broken', () => {
  const cookie = serialiseSessionCookie(createSessionId(), { secure: false })
  expect(cookie).toContain(`${SESSION_COOKIE}=`)
  expect(cookie).not.toContain('__Host-')
  expect(cookie).not.toContain('Secure')
})

test('resolveSession mints and sets a cookie when absent', () => {
  const { sessionId, setCookie } = resolveSession(
    new Request('https://studio.example/api/run'),
  )
  expect(sessionId).toMatch(HEX_64)
  expect(setCookie).toContain(sessionId)
})

test('resolveSession reuses an existing session and sets no cookie', () => {
  const id = createSessionId()
  const { sessionId, setCookie } = resolveSession(
    withCookie(`${SESSION_COOKIE}=${id}`),
  )
  expect(sessionId).toBe(id)
  expect(setCookie).toBeNull()
})

test('resolveSession re-mints rather than trusting a malformed cookie', () => {
  const { sessionId, setCookie } = resolveSession(
    withCookie(`${SESSION_COOKIE}=not-a-valid-session`),
  )
  expect(sessionId).toMatch(HEX_64)
  expect(sessionId).not.toBe('not-a-valid-session')
  expect(setCookie).not.toBeNull()
})

test('thread id derivation is deterministic', async () => {
  const session = createSessionId()
  expect(await deriveThreadId(session, 'thread-1')).toBe(
    await deriveThreadId(session, 'thread-1'),
  )
})

test('THE security property: same threadKey, different sessions, different threads', async () => {
  // Without this, two visitors naming a thread the same way would share a
  // container — and every container holds this app's ANTHROPIC_API_KEY.
  const a = await deriveThreadId(createSessionId(), 'my-video')
  const b = await deriveThreadId(createSessionId(), 'my-video')
  expect(a).not.toBe(b)
})

test('the derived id does not leak the session id', async () => {
  // It becomes a container DO name and appears in R2 keys and the run log.
  const session = createSessionId()
  const threadId = await deriveThreadId(session, 'my-video')
  expect(threadId).not.toContain(session)
  expect(threadId).toMatch(/^[0-9a-f]{32}$/u)
})

test('the derived id fits the sandbox ID limit', async () => {
  // @cloudflare/sandbox rejects container IDs over 63 chars (a DNS label).
  // Full SHA-256 hex is 64 — one over — and the rejection only fires at the
  // first getSandbox() call of a real run, which is exactly how it shipped
  // broken once. Pin the truncation.
  const threadId = await deriveThreadId(createSessionId(), 'my-video')
  expect(threadId.length).toBeLessThanOrEqual(63)
  expect(threadId.length).toBe(32)
})

test('field boundaries cannot be shifted to collide', async () => {
  // A naive `session + threadKey` concatenation would make these identical.
  const first = await deriveThreadId('a'.repeat(64), 'bc')
  const second = await deriveThreadId(`${'a'.repeat(63)}b`, 'c')
  expect(first).not.toBe(second)
})
