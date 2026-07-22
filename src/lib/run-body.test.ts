import { expect, test } from 'bun:test'
import { runBodySchema } from './run-body'

const message = { role: 'user', content: 'hi' }

test('accepts threadKey at the top level', () => {
  const parsed = runBodySchema.safeParse({
    messages: [message],
    threadKey: 'top',
  })
  expect(parsed.success).toBe(true)
  if (parsed.success) expect(parsed.data.threadKey).toBe('top')
})

test('accepts threadKey nested under data', () => {
  const parsed = runBodySchema.safeParse({
    messages: [message],
    data: { threadKey: 'in-data' },
  })
  expect(parsed.success).toBe(true)
  if (parsed.success) expect(parsed.data.threadKey).toBe('in-data')
})

test('accepts threadKey nested under forwardedProps', () => {
  const parsed = runBodySchema.safeParse({
    messages: [message],
    forwardedProps: { threadKey: 'forwarded' },
  })
  expect(parsed.success).toBe(true)
  if (parsed.success) expect(parsed.data.threadKey).toBe('forwarded')
})

test('the top layer wins when threadKey appears at several layers', () => {
  const parsed = runBodySchema.safeParse({
    messages: [message],
    threadKey: 'top',
    data: { threadKey: 'stale-mirror' },
    forwardedProps: { threadKey: 'stale-mirror' },
  })
  expect(parsed.success).toBe(true)
  if (parsed.success) expect(parsed.data.threadKey).toBe('top')
})

test('an empty top-level threadKey falls through to a nested layer', () => {
  const parsed = runBodySchema.safeParse({
    messages: [message],
    threadKey: '',
    forwardedProps: { threadKey: 'real' },
  })
  expect(parsed.success).toBe(true)
  if (parsed.success) expect(parsed.data.threadKey).toBe('real')
})

test('messages is read from the top level only', () => {
  const parsed = runBodySchema.safeParse({
    data: { messages: [message], threadKey: 'k' },
  })
  expect(parsed.success).toBe(false)
})

test('rejects a missing threadKey', () => {
  expect(runBodySchema.safeParse({ messages: [message] }).success).toBe(false)
})

test('rejects a non-string threadKey', () => {
  expect(
    runBodySchema.safeParse({ messages: [message], threadKey: 42 }).success,
  ).toBe(false)
})

test('rejects a threadKey longer than 128 characters', () => {
  expect(
    runBodySchema.safeParse({
      messages: [message],
      threadKey: 'k'.repeat(129),
    }).success,
  ).toBe(false)
})

test('rejects empty messages', () => {
  expect(
    runBodySchema.safeParse({ messages: [], threadKey: 'k' }).success,
  ).toBe(false)
})

test('rejects a null or non-object body', () => {
  expect(runBodySchema.safeParse(null).success).toBe(false)
  expect(runBodySchema.safeParse('body').success).toBe(false)
})
