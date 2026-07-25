import { expect, test } from 'bun:test'
import { EventType } from '@tanstack/ai'
import { harnessSecrets, readAgentSessionId, resolveHarness } from './harness'

test('uses Grok when XAI_API_KEY is set', () => {
  expect(resolveHarness({ XAI_API_KEY: 'xai' })).toBe('grok')
})

test('uses Claude when only ANTHROPIC_API_KEY is set', () => {
  expect(resolveHarness({ ANTHROPIC_API_KEY: 'ant' })).toBe('claude-code')
})

test('prefers XAI when both keys are set', () => {
  expect(resolveHarness({ XAI_API_KEY: 'xai', ANTHROPIC_API_KEY: 'ant' })).toBe(
    'grok',
  )
  expect(
    harnessSecrets({ XAI_API_KEY: 'xai', ANTHROPIC_API_KEY: 'ant' }),
  ).toEqual({ XAI_API_KEY: 'xai' })
})

test('throws when neither key is present', () => {
  expect(() => resolveHarness({})).toThrow(/No agent API key/u)
  expect(() =>
    resolveHarness({ XAI_API_KEY: '', ANTHROPIC_API_KEY: '' }),
  ).toThrow(/No agent API key/u)
})

test('injects only the selected harness key', () => {
  expect(harnessSecrets({ XAI_API_KEY: 'xai' })).toEqual({
    XAI_API_KEY: 'xai',
  })
  expect(harnessSecrets({ ANTHROPIC_API_KEY: 'ant' })).toEqual({
    ANTHROPIC_API_KEY: 'ant',
  })
})

test('reads session ids from either harness event', () => {
  expect(
    readAgentSessionId(
      {
        type: EventType.CUSTOM,
        name: 'claude-code.session-id',
        value: { sessionId: 'c1' },
      },
      EventType.CUSTOM,
    ),
  ).toBe('c1')
  expect(
    readAgentSessionId(
      {
        type: EventType.CUSTOM,
        name: 'grok-build.session-id',
        value: { sessionId: 'g1' },
      },
      EventType.CUSTOM,
    ),
  ).toBe('g1')
  expect(
    readAgentSessionId(
      {
        type: EventType.CUSTOM,
        name: 'other',
        value: { sessionId: 'x' },
      },
      EventType.CUSTOM,
    ),
  ).toBeUndefined()
})
