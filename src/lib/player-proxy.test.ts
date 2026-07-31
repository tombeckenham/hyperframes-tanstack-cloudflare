import { expect, test } from 'bun:test'
import {
  PLAYER_ASSET_ERR_PREFIX,
  PLAYER_ASSET_MAX_BYTES,
  PLAYER_FETCH_TIMEOUT_SEC,
  assetCurlCommand,
  classifyAssetFetchFailure,
  compositionCurlCommand,
  decodeBase64Payload,
  isPlayerPort,
  isPlayerProject,
  isPlayerThreadKey,
  isSafePlayerAssetPath,
  mimeForAssetPath,
  playerMediaBasePath,
  rewritePlayerAssetBase,
} from './player-proxy'

test('player port rejects control plane and non-ports', () => {
  expect(isPlayerPort(3002)).toBe(true)
  expect(isPlayerPort(3000)).toBe(false)
  expect(isPlayerPort(80)).toBe(false)
  expect(isPlayerPort(1.5)).toBe(false)
  expect(isPlayerPort(65535)).toBe(true)
  expect(isPlayerPort(65536)).toBe(false)
})

test('isSafePlayerAssetPath blocks traversal and schemes', () => {
  expect(isSafePlayerAssetPath('assets/dolphin.jpg')).toBe(true)
  expect(isSafePlayerAssetPath('assets/nested/x.png')).toBe(true)
  expect(isSafePlayerAssetPath('../etc/passwd')).toBe(false)
  expect(isSafePlayerAssetPath('/assets/x.jpg')).toBe(false)
  expect(isSafePlayerAssetPath('https://evil.example/x')).toBe(false)
  expect(isSafePlayerAssetPath('')).toBe(false)
  expect(isSafePlayerAssetPath('assets\\x.jpg')).toBe(false)
  expect(isSafePlayerAssetPath('assets/foo bar.jpg')).toBe(false)
  expect(isSafePlayerAssetPath(`a${'b'.repeat(512)}`)).toBe(false)
})

test('playerMediaBasePath encodes and ends with slash', () => {
  expect(playerMediaBasePath('ab-cd', 3002, 'studio')).toBe(
    '/api/player/media/ab-cd/3002/studio/',
  )
  expect(playerMediaBasePath('a/b', 3002, 'studio')).toBe(
    '/api/player/media/a%2Fb/3002/studio/',
  )
})

test('rewritePlayerAssetBase retargets studio base and absolute preview paths', () => {
  const html = `<!doctype html><html><head><base href="/api/projects/studio/preview/"><title>t</title></head><body><img src="/api/projects/studio/preview/assets/dolphin.jpg"></body></html>`
  const out = rewritePlayerAssetBase(html, 'tkey', 3002, 'studio')
  expect(out).toContain('<base href="/api/player/media/tkey/3002/studio/">')
  expect(out).not.toContain('/api/projects/studio/preview/')
  expect(out).toContain(
    'src="/api/player/media/tkey/3002/studio/assets/dolphin.jpg"',
  )
})

test('rewritePlayerAssetBase rewrites single-quoted base href', () => {
  const html = `<head><base href='/api/projects/studio/preview/'></head>`
  const out = rewritePlayerAssetBase(html, 'k', 3002, 'studio')
  expect(out).toContain('<base href="/api/player/media/k/3002/studio/">')
  expect(out).not.toContain('/api/projects/studio/preview/')
})

test('rewritePlayerAssetBase injects base when missing', () => {
  const html = `<html><head></head><body></body></html>`
  const out = rewritePlayerAssetBase(html, 'k', 3002, 'studio')
  expect(out).toMatch(
    /<head><base href="\/api\/player\/media\/k\/3002\/studio\/">/u,
  )
})

test('curl commands cap size and encode path segments', () => {
  const composition = compositionCurlCommand(3002, 'studio')
  expect(composition).toContain(
    'http://127.0.0.1:3002/api/projects/studio/preview',
  )
  expect(composition).toContain(`--max-time ${PLAYER_FETCH_TIMEOUT_SEC}`)
  expect(composition).toContain('-sfS')

  const cmd = assetCurlCommand(3002, 'studio', 'assets/a b.jpg')
  expect(cmd).toContain(`--max-filesize ${PLAYER_ASSET_MAX_BYTES}`)
  expect(cmd).toContain('assets/a%20b.jpg')
  expect(cmd).toContain('base64')
  expect(cmd).toContain("-w '%{http_code}'")
  expect(cmd).toContain(PLAYER_ASSET_ERR_PREFIX)
  // curl downloads to a file; encode failures fail the exec; status rides a
  // trailing test — never `exit`, which kills the sandbox's persistent shell.
  expect(cmd).toContain('-o "$f"')
  expect(cmd.endsWith('[ $s -eq 0 ]')).toBe(true)
  // Shell builtin `exit` would kill the sandbox's persistent exec session.
  expect(cmd).not.toMatch(/(?:^|[\s;|&])exit(?:\s|$)/u)
})

test('classifyAssetFetchFailure maps stderr markers to kinds', () => {
  expect(
    classifyAssetFetchFailure({
      success: true,
      stdout: 'YWJj',
      stderr: '',
    }),
  ).toBeNull()
  expect(
    classifyAssetFetchFailure({
      success: false,
      stdout: '',
      stderr: `${PLAYER_ASSET_ERR_PREFIX} curl_status=0 http=404`,
    }),
  ).toBe('not_found')
  expect(
    classifyAssetFetchFailure({
      success: false,
      stdout: '',
      stderr: `${PLAYER_ASSET_ERR_PREFIX} curl_status=63 http=000`,
    }),
  ).toBe('too_large')
  expect(
    classifyAssetFetchFailure({
      success: false,
      stdout: '',
      stderr: `${PLAYER_ASSET_ERR_PREFIX} encode`,
    }),
  ).toBe('encode')
  expect(
    classifyAssetFetchFailure({
      success: false,
      stdout: '',
      stderr: `${PLAYER_ASSET_ERR_PREFIX} curl_status=28 http=000`,
    }),
  ).toBe('upstream')
})

test('isPlayerThreadKey matches minted keys, rejects the rest', () => {
  expect(isPlayerThreadKey(crypto.randomUUID().slice(0, 13))).toBe(true)
  expect(isPlayerThreadKey('has space')).toBe(false)
  expect(isPlayerThreadKey('')).toBe(false)
  expect(isPlayerThreadKey('a'.repeat(129))).toBe(false)
  expect(isPlayerThreadKey('$(rm)')).toBe(false)
})

/** Base64 of `byteLength` zero bytes without spreading a huge array. */
function base64Zeros(byteLength: number): string {
  const fullGroups = Math.floor(byteLength / 3)
  const rem = byteLength % 3
  let out = 'A'.repeat(fullGroups * 4)
  if (rem === 1) out += 'AA=='
  else if (rem === 2) out += 'AAA='
  return out
}

test('decodeBase64Payload round-trips and rejects junk and oversize', () => {
  const bytes = new TextEncoder().encode('hi')
  const b64 = btoa(String.fromCharCode(...bytes))
  const ok = decodeBase64Payload(b64)
  expect(ok.ok).toBe(true)
  if (ok.ok) expect([...ok.bytes]).toEqual([...bytes])

  expect(decodeBase64Payload('not!!base64')).toEqual({
    ok: false,
    reason: 'invalid',
  })
  expect(decodeBase64Payload('')).toEqual({ ok: false, reason: 'empty' })

  // Oversize decoded payload must fail closed (Worker memory backstop).
  expect(decodeBase64Payload(base64Zeros(PLAYER_ASSET_MAX_BYTES + 1))).toEqual({
    ok: false,
    reason: 'too_large',
  })

  // Exactly at the cap still succeeds.
  const exactDecoded = decodeBase64Payload(base64Zeros(PLAYER_ASSET_MAX_BYTES))
  expect(exactDecoded.ok).toBe(true)
  if (exactDecoded.ok) {
    expect(exactDecoded.bytes.byteLength).toBe(PLAYER_ASSET_MAX_BYTES)
  }
})

test('mimeForAssetPath maps common media', () => {
  expect(mimeForAssetPath('assets/dolphin.jpg')).toBe('image/jpeg')
  expect(mimeForAssetPath('x.WEBP')).toBe('image/webp')
  expect(mimeForAssetPath('noext')).toBe('application/octet-stream')
})

test('isPlayerProject shape', () => {
  expect(isPlayerProject('studio')).toBe(true)
  expect(isPlayerProject('../x')).toBe(false)
  expect(isPlayerProject('a'.repeat(65))).toBe(false)
  expect(isPlayerProject('foo;rm')).toBe(false)
})
