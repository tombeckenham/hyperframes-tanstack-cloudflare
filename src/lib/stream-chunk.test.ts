import { expect, test } from 'bun:test'
import { EventType } from '@tanstack/ai'
import { isStreamChunk } from './stream-chunk'

test('accepts representative real chunk shapes', () => {
  expect(
    isStreamChunk({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'm1',
      delta: 'hello',
    }),
  ).toBe(true)
  expect(
    isStreamChunk({
      type: EventType.TOOL_CALL_START,
      toolCallId: 'c1',
      toolCallName: 'exposePreview',
    }),
  ).toBe(true)
  expect(isStreamChunk({ type: EventType.RUN_ERROR, error: 'boom' })).toBe(true)
})

test('rejects frames that are not chunks', () => {
  // The coordinator's terminal frame — must NOT pass as a chunk.
  expect(isStreamChunk({ type: 'status', record: {} })).toBe(false)
  expect(isStreamChunk({ type: 'nope' })).toBe(false)
  expect(isStreamChunk({})).toBe(false)
  expect(isStreamChunk(null)).toBe(false)
  expect(isStreamChunk('TEXT_MESSAGE_CONTENT')).toBe(false)
  expect(isStreamChunk({ type: 42 })).toBe(false)
})
