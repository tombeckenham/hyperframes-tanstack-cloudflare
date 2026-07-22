import { expect, test } from 'bun:test'
import { extractToolUrl, latestArtifactUrls } from './tool-urls'
import type { UIMessage } from '@tanstack/ai-client'

test('extractToolUrl reads a plain object', () => {
  expect(extractToolUrl({ url: 'https://x.trycloudflare.com' })).toBe(
    'https://x.trycloudflare.com',
  )
})

test('extractToolUrl reads a JSON string of the object', () => {
  expect(extractToolUrl('{"ok":true,"url":"/p/previews/t/x.html"}')).toBe(
    '/p/previews/t/x.html',
  )
})

test('extractToolUrl reads an MCP content array of text blocks', () => {
  const output = [{ type: 'text', text: '{"url":"/r/renders/t/a.mp4"}' }]
  expect(extractToolUrl(output)).toBe('/r/renders/t/a.mp4')
})

test('extractToolUrl reads a nested content property', () => {
  const output = {
    content: [{ type: 'text', text: '{"url":"/p/previews/t/y.html"}' }],
  }
  expect(extractToolUrl(output)).toBe('/p/previews/t/y.html')
})

test('extractToolUrl rejects non-URL payloads', () => {
  expect(extractToolUrl(undefined)).toBeNull()
  expect(extractToolUrl('not json')).toBeNull()
  expect(extractToolUrl({ ok: true })).toBeNull()
  expect(extractToolUrl({ url: '' })).toBeNull()
  expect(extractToolUrl(42)).toBeNull()
})

const toolCallMessage = (
  name: string,
  output: unknown,
  id = 'call-1',
): UIMessage => ({
  id: `m-${name}-${id}`,
  role: 'assistant',
  parts: [
    {
      type: 'tool-call',
      id,
      name,
      arguments: '{}',
      state: 'complete',
      output,
    },
  ],
})

test('latestArtifactUrls picks up preview and composition, last one wins', () => {
  const messages: Array<UIMessage> = [
    toolCallMessage('exposePreview', { url: 'https://old.trycloudflare.com' }),
    toolCallMessage('mcp__tanstack__exposePreview', {
      url: 'https://new.trycloudflare.com',
    }),
    toolCallMessage('publishComposition', {
      ok: true,
      url: '/p/previews/t/final.html',
    }),
  ]
  expect(latestArtifactUrls(messages)).toEqual({
    previewUrl: 'https://new.trycloudflare.com',
    compositionUrl: '/p/previews/t/final.html',
  })
})

test('latestArtifactUrls falls back to the tool-result part', () => {
  const message: UIMessage = {
    id: 'm-1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-call',
        id: 'call-9',
        name: 'exposePreview',
        arguments: '{}',
        state: 'complete',
      },
      {
        type: 'tool-result',
        toolCallId: 'call-9',
        content: '{"url":"https://tail.trycloudflare.com"}',
        state: 'complete',
      },
    ],
  }
  expect(latestArtifactUrls([message]).previewUrl).toBe(
    'https://tail.trycloudflare.com',
  )
})

test('latestArtifactUrls refuses a composition URL outside /p/', () => {
  const messages = [
    toolCallMessage('publishComposition', {
      url: 'https://evil.example/p.html',
    }),
  ]
  expect(latestArtifactUrls(messages).compositionUrl).toBeNull()
})
