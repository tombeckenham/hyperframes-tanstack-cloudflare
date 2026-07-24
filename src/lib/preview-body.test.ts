import { expect, test } from 'bun:test'
import { isPreviewTunnelUrl, previewBodySchema } from './preview-body'

test('accepts a quick-tunnel URL', () => {
  expect(
    isPreviewTunnelUrl('https://witty-otter-lands.trycloudflare.com'),
  ).toBe(true)
})

test('rejects everything that is not an https quick tunnel', () => {
  // The probe fetches the URL server-side; anything here becomes a request
  // the Worker makes on the caller's behalf.
  expect(isPreviewTunnelUrl('http://x.trycloudflare.com')).toBe(false)
  expect(isPreviewTunnelUrl('https://trycloudflare.com')).toBe(false)
  expect(isPreviewTunnelUrl('https://evil.com/?trycloudflare.com')).toBe(false)
  expect(isPreviewTunnelUrl('https://xtrycloudflare.com')).toBe(false)
  expect(isPreviewTunnelUrl('https://internal.host')).toBe(false)
  expect(isPreviewTunnelUrl('not a url')).toBe(false)
})

test('a suffix match cannot be faked with a longer hostname', () => {
  // endsWith('.trycloudflare.com') requires the dot, so a registrable domain
  // like evil-trycloudflare.com does not pass.
  expect(isPreviewTunnelUrl('https://evil-trycloudflare.com')).toBe(false)
  expect(isPreviewTunnelUrl('https://a.b.trycloudflare.com')).toBe(true)
})

test('ensure body requires a threadKey', () => {
  expect(
    previewBodySchema.safeParse({ action: 'ensure', threadKey: 'abc' }).success,
  ).toBe(true)
  expect(previewBodySchema.safeParse({ action: 'ensure' }).success).toBe(false)
  expect(
    previewBodySchema.safeParse({ action: 'ensure', threadKey: '' }).success,
  ).toBe(false)
})

test('probe body requires a tunnel-shaped url', () => {
  expect(
    previewBodySchema.safeParse({
      action: 'probe',
      url: 'https://a.trycloudflare.com',
    }).success,
  ).toBe(true)
  expect(
    previewBodySchema.safeParse({ action: 'probe', url: 'https://evil.com' })
      .success,
  ).toBe(false)
})

test('unknown actions are rejected', () => {
  expect(previewBodySchema.safeParse({ action: 'destroy' }).success).toBe(false)
})
