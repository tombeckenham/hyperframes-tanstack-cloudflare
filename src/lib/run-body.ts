/**
 * The `/api/run` request body: what `useChat` actually sends, flattened and
 * validated. Pure, so it is testable the way `tool-urls` is — this is the
 * contract boundary with the adapter's wire format, and the nastiest available
 * regression (threadKey read from the wrong layer) lands a run in the WRONG
 * thread with no error at all.
 */
import { z } from 'zod'
import type { ModelMessage } from '@tanstack/ai'

/**
 * The layers `useChat` may nest forwarded props in. The installed client sends
 * `{ messages, forwardedProps, data: { ...forwardedProps } }`; older adapters
 * sent top-level fields. Top layer wins so a future client that promotes a key
 * to the top level cannot be shadowed by a stale mirror underneath.
 */
function bodyLayers(value: object): Array<object> {
  const layers: Array<object> = [value]
  if (
    'data' in value &&
    value.data !== null &&
    typeof value.data === 'object'
  ) {
    layers.push(value.data)
  }
  if (
    'forwardedProps' in value &&
    value.forwardedProps !== null &&
    typeof value.forwardedProps === 'object'
  ) {
    layers.push(value.forwardedProps)
  }
  return layers
}

/** First non-empty string for `key` across any body layer (top layer wins). */
function readForwarded(value: object, key: string): string | undefined {
  for (const layer of bodyLayers(value)) {
    const candidate: unknown = Reflect.get(layer, key)
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * The browser-chosen fields this app forwards. `threadKey` names the thread;
 * `sessionId` is the claude-code session echo — the adapter emits it as a
 * CUSTOM `claude-code.session-id` chunk, the client sends it back, and the
 * coordinator turns it into `--resume` so the in-sandbox agent keeps its full
 * working context (loaded skills, read files, interview state) across turns.
 * Without it every turn is a fresh session fed a lossy text preamble that
 * drops tool calls — which is how "pick B" once landed on an agent that could
 * no longer see the options it had offered.
 */
const FORWARDED_KEYS = ['threadKey', 'sessionId'] as const

/**
 * Flatten the nested `data`/`forwardedProps` layers into one object.
 * `messages` is deliberately read from the top level ONLY — the client always
 * sends it there, and a `messages` key inside `data` would be someone else's.
 */
function flattenRunBody(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const flat: Record<string, unknown> = {}
  if ('messages' in value) flat['messages'] = value.messages
  for (const key of FORWARDED_KEYS) {
    const found = readForwarded(value, key)
    if (found !== undefined) flat[key] = found
  }
  return flat
}

export const runBodySchema = z.preprocess(
  flattenRunBody,
  z.object({
    messages: z
      .array(z.custom<ModelMessage>())
      .min(1, 'body.messages must be a non-empty array'),
    /**
     * Client-chosen, one per chat thread, NOT a secret and NOT a thread id —
     * it only becomes one after being hashed with the visitor's session id.
     */
    threadKey: z.string().min(1).max(128),
    /**
     * The claude-code session to resume, echoed from a prior run's
     * `claude-code.session-id` chunk. Harmless if stale or forged: it only
     * selects a session file inside the caller's OWN thread-pinned container.
     */
    sessionId: z.string().min(1).max(128).optional(),
  }),
)

export type RunBody = z.infer<typeof runBodySchema>
