import { expect, test } from 'bun:test'
import {
  SESSION_COOKIE,
  createSessionId,
  deriveThreadId,
  readSessionId,
  resolveSession,
  serialiseSessionCookie,
} from './session'

const withCookie = (cookie: string, url = 'https://studio.example/api/run') =>
  new Request(url, { headers: { cookie } })

test('a session id is 256 bits of hex', () => {
  const id = createSessionId()
  expect(id).toMatch(/^[0-9a-f]{64}$/)
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
  for (const bad of [
    'not-hex',
    'ABCDEF', // too short, and uppercase
    `${'a'.repeat(63)}`,
    `${'a'.repeat(65)}`,
    `${'A'.repeat(64)}`, // uppercase hex is not what we issue
    '../../etc/passwd',
  ]) {
    expect(readSessionId(withCookie(`${SESSION_COOKIE}=${bad}`))).toBeNull()
  }
})

test('missing cookie header is null, not a throw', () => {
  expect(readSessionId(new Request('https://studio.example/'))).toBeNull()
})

test('cookie is HttpOnly and SameSite=Lax', () => {
  // HttpOnly is what keeps the value away from the LLM-authored HTML this app
  // serves; SameSite=Lax withholds it from cross-site POSTs.
  const cookie = serialiseSessionCookie(createSessionId(), { secure: true })
  expect(cookie).toContain('HttpOnly')
  expect(cookie).toContain('SameSite=Lax')
  expect(cookie).toContain('Path=/')
  expect(cookie).toContain('Secure')
})

test('Secure is omitted on http so local dev is not silently broken', () => {
  const cookie = serialiseSessionCookie(createSessionId(), { secure: false })
  expect(cookie).not.toContain('Secure')
})

test('resolveSession mints and sets a cookie when absent', () => {
  const { sessionId, setCookie } = resolveSession(
    new Request('https://studio.example/api/run'),
  )
  expect(sessionId).toMatch(/^[0-9a-f]{64}$/)
  expect(setCookie).toContain(`${SESSION_COOKIE}=${sessionId}`)
})

test('resolveSession reuses an existing session and sets no cookie', () => {
  const id = createSessionId()
  const { sessionId, setCookie } = resolveSession(
    withCookie(`${SESSION_COOKIE}=${id}`),
  )
  expect(sessionId).toBe(id)
  expect(setCookie).toBeNull()
})

test('thread id derivation is deterministic', async () => {
  const session = createSessionId()
  expect(await deriveThreadId(session, 'thread-1')).toBe(
    await deriveThreadId(session, 'thread-1'),
  )
})

test('THE security property: same threadKey, different sessions, different threads', async () => {
  // Without this, two visitors picking the same thread name would share a
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
  expect(threadId).toMatch(/^[0-9a-f]{64}$/)
})

test('field boundaries cannot be shifted to collide', async () => {
  // A naive `session + threadKey` concatenation would make these identical.
  const first = await deriveThreadId(`${'a'.repeat(64)}`, 'bc')
  const second = await deriveThreadId(`${'a'.repeat(63)}b`, 'c')
  expect(first).not.toBe(second)
})
