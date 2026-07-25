import { expect, test } from 'bun:test'
import { EventType } from '@tanstack/ai'
import { readClaudeSessionId } from './claude-session'
import type { StreamChunk } from '@tanstack/ai'

const custom = (name: string, value: unknown): StreamChunk => ({
  type: EventType.CUSTOM,
  name,
  value,
})

test('reads the session id from the claude-code adapter announcement', () => {
  expect(
    readClaudeSessionId(
      custom('claude-code.session-id', { sessionId: 'sess-1', model: 'x' }),
    ),
  ).toBe('sess-1')
})

test('reads the session id from the grok-build adapter announcement', () => {
  expect(
    readClaudeSessionId(
      custom('grok-build.session-id', { sessionId: 'grok-sess' }),
    ),
  ).toBe('grok-sess')
})

test('ignores other chunks and malformed values', () => {
  expect(
    readClaudeSessionId({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'm',
      delta: 'x',
    }),
  ).toBeUndefined()
  expect(readClaudeSessionId(custom('other.event', { sessionId: 's' }))).toBe(
    undefined,
  )
  expect(
    readClaudeSessionId(custom('claude-code.session-id', 'sess-1')),
  ).toBeUndefined()
  expect(
    readClaudeSessionId(custom('claude-code.session-id', { sessionId: '' })),
  ).toBeUndefined()
})
