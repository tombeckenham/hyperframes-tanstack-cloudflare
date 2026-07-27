import { expect, test } from 'bun:test'
import {
  PLAYER_ASSET_MAX_BYTES,
  assetCurlCommand,
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
})

test('isSafePlayerAssetPath blocks traversal and schemes', () => {
  expect(isSafePlayerAssetPath('assets/dolphin.jpg')).toBe(true)
  expect(isSafePlayerAssetPath('assets/nested/x.png')).toBe(true)
  expect(isSafePlayerAssetPath('../etc/passwd')).toBe(false)
  expect(isSafePlayerAssetPath('/assets/x.jpg')).toBe(false)
  expect(isSafePlayerAssetPath('https://evil.example/x')).toBe(false)
  expect(isSafePlayerAssetPath('')).toBe(false)
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

test('rewritePlayerAssetBase injects base when missing', () => {
  const html = `<html><head></head><body></body></html>`
  const out = rewritePlayerAssetBase(html, 'k', 3002, 'studio')
  expect(out).toMatch(
    /<head><base href="\/api\/player\/media\/k\/3002\/studio\/">/u,
  )
})

test('curl commands cap size and encode path segments', () => {
  expect(compositionCurlCommand(3002, 'studio')).toContain(
    'http://127.0.0.1:3002/api/projects/studio/preview',
  )
  const cmd = assetCurlCommand(3002, 'studio', 'assets/a b.jpg')
  expect(cmd).toContain(`--max-filesize ${PLAYER_ASSET_MAX_BYTES}`)
  expect(cmd).toContain('assets/a%20b.jpg')
  expect(cmd).toContain('base64')
  // curl downloads to a file and ITS status is the exec's status — piping
  // curl straight into base64 would serve truncated bytes as a 200.
  expect(cmd).toContain('-o "$f"')
  expect(cmd).toContain('exit $s')
})

test('isPlayerThreadKey matches minted keys, rejects the rest', () => {
  expect(isPlayerThreadKey(crypto.randomUUID().slice(0, 13))).toBe(true)
  expect(isPlayerThreadKey('has space')).toBe(false)
  expect(isPlayerThreadKey('')).toBe(false)
})

test('decodeBase64Payload round-trips and rejects junk', () => {
  const bytes = new TextEncoder().encode('hi')
  const b64 = btoa(String.fromCharCode(...bytes))
  expect([...(decodeBase64Payload(b64) ?? [])]).toEqual([...bytes])
  expect(decodeBase64Payload('not!!base64')).toBeNull()
  expect(decodeBase64Payload('')).toBeNull()
})

test('mimeForAssetPath maps common media', () => {
  expect(mimeForAssetPath('assets/dolphin.jpg')).toBe('image/jpeg')
  expect(mimeForAssetPath('x.WEBP')).toBe('image/webp')
  expect(mimeForAssetPath('noext')).toBe('application/octet-stream')
})

test('isPlayerProject shape', () => {
  expect(isPlayerProject('studio')).toBe(true)
  expect(isPlayerProject('../x')).toBe(false)
})
