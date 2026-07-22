/**
 * Frame guard for the coordinator's WebSocket tail. The tail frames are JSON
 * our own coordinator wrote, so a malformed frame is a bug there, not attacker
 * input — but our lint (rightly) forbids the upstream `chunk as StreamChunk`.
 *
 * `StreamChunk` is the AG-UI event union discriminated by a string `type`
 * drawn from the `EventType` enum, so enum membership is what a guard can
 * honestly check. Honestly, but not exactly: the enum is a slight SUPERSET of
 * the union's discriminants (deprecated `THINKING_*`, `RAW`, the `*_CHUNK`
 * aliases), so a frame using one of those passes. All of them are chunk types
 * the client-side stream processor knows how to skip.
 */
import { EventType } from '@tanstack/ai'
import type { StreamChunk } from '@tanstack/ai'

const STREAM_CHUNK_TYPES: ReadonlySet<string> = new Set(
  Object.values(EventType),
)

export function isStreamChunk(value: unknown): value is StreamChunk {
  if (value === null || typeof value !== 'object') return false
  const type: unknown = Reflect.get(value, 'type')
  return typeof type === 'string' && STREAM_CHUNK_TYPES.has(type)
}
