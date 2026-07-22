import { expect, test } from 'bun:test'
import {
  extractToolError,
  extractToolUrl,
  latestArtifactUrls,
} from './tool-urls'
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

test('latestArtifactUrls refuses a non-https preview URL', () => {
  const messages = [
    toolCallMessage('exposePreview', { url: 'javascript:alert(1)' }),
    toolCallMessage('exposePreview', { url: 'http://plain.example' }),
  ]
  expect(latestArtifactUrls(messages).previewUrl).toBeNull()
})

test('latestArtifactUrls prefers part.output over the tool-result', () => {
  const message: UIMessage = {
    id: 'm-2',
    role: 'assistant',
    parts: [
      {
        type: 'tool-call',
        id: 'call-3',
        name: 'exposePreview',
        arguments: '{}',
        state: 'complete',
        output: { url: 'https://from-output.trycloudflare.com' },
      },
      {
        type: 'tool-result',
        toolCallId: 'call-3',
        content: '{"url":"https://from-result.trycloudflare.com"}',
        state: 'complete',
      },
    ],
  }
  expect(latestArtifactUrls([message]).previewUrl).toBe(
    'https://from-output.trycloudflare.com',
  )
})

test('extractToolUrl skips array entries without a URL', () => {
  const output = [
    { type: 'text', text: 'progress note' },
    { type: 'text', text: '{"url":"/p/previews/t/z.html"}' },
  ]
  expect(extractToolUrl(output)).toBe('/p/previews/t/z.html')
})

test('extractToolUrl falls through an empty url to the text lane', () => {
  expect(
    extractToolUrl({ url: '', text: '{"url":"/p/previews/t/w.html"}' }),
  ).toBe('/p/previews/t/w.html')
})

test('extractToolError finds ok:false failures wherever the transport put them', () => {
  expect(extractToolError({ ok: false, error: 'bundle failed (exit 1)' })).toBe(
    'bundle failed (exit 1)',
  )
  expect(extractToolError({ ok: false })).toBe('tool reported failure')
  expect(extractToolError('{"ok":false,"error":"no such dir"}')).toBe(
    'no such dir',
  )
  expect(
    extractToolError([{ type: 'text', text: '{"ok":false,"error":"boom"}' }]),
  ).toBe('boom')
})

test('extractToolError reads a bare error string, and ignores successes', () => {
  expect(extractToolError({ error: 'went wrong' })).toBe('went wrong')
  expect(extractToolError({ ok: true, url: '/p/x' })).toBeNull()
  expect(extractToolError('plain text output')).toBeNull()
  expect(extractToolError(undefined)).toBeNull()
})
