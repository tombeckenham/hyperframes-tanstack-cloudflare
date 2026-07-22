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
 * The only browser-chosen field this app forwards. The upstream example also
 * carried harness/model pickers here; this app is single-harness, so they are
 * gone rather than ignored.
 */
const FORWARDED_KEYS = ['threadKey'] as const

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
  }),
)

export type RunBody = z.infer<typeof runBodySchema>
