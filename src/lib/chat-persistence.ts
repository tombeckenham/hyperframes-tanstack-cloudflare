/**
 * localStorage adapter for TanStack AI's `ChatClientPersistence` — a reload
 * restores the transcript, matching the server side, where the sandbox
 * already resumes per thread (`lifecycle: { reuse: 'thread' }`) and the run
 * log is durable. The chat client hydrates from `getItem` at construction and
 * writes back on every message change; the store is keyed by the client `id`,
 * which the studio derives from the threadKey.
 *
 * Failure posture: storage full, private mode, SSR — all degrade to "no
 * persistence", never to a broken chat. A transcript that fails structural
 * validation is discarded rather than half-hydrated.
 */
import type { UIMessage } from '@tanstack/ai-client'
import type { ChatClientPersistence } from '@tanstack/ai-client'

const KEY_PREFIX = 'hf-chat:'

function isUIMessageArray(value: unknown): value is Array<UIMessage> {
  return (
    Array.isArray(value) &&
    value.every(
      (message) =>
        message !== null &&
        typeof message === 'object' &&
        typeof Reflect.get(message, 'id') === 'string' &&
        typeof Reflect.get(message, 'role') === 'string' &&
        Array.isArray(Reflect.get(message, 'parts')),
    )
  )
}

export const localChatPersistence: ChatClientPersistence = {
  getItem(id) {
    if (typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem(KEY_PREFIX + id)
      if (raw === null) return null
      const value: unknown = JSON.parse(raw)
      return isUIMessageArray(value) ? value : null
    } catch {
      return null
    }
  },
  setItem(id, messages) {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(KEY_PREFIX + id, JSON.stringify(messages))
    } catch {
      // Quota or private mode — the live session still works unpersisted.
    }
  },
  removeItem(id) {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.removeItem(KEY_PREFIX + id)
    } catch {
      // Nothing to do.
    }
  },
}
