/**
 * Client half of the claude-code session round-trip: the adapter announces
 * each run's session as a CUSTOM `claude-code.session-id` chunk; the studio
 * remembers it per thread and echoes it in the next run's body, which the
 * coordinator turns into `--resume`. That is what keeps the in-sandbox
 * agent's working context — loaded skills, read files, interview state —
 * alive across turns.
 */
import { EventType } from '@tanstack/ai'
import type { StreamChunk } from '@tanstack/ai'

const SESSION_ID_EVENT = 'claude-code.session-id'

/** Read the session id out of a stream chunk, or undefined for other chunks. */
export function readClaudeSessionId(chunk: StreamChunk): string | undefined {
  if (chunk.type !== EventType.CUSTOM) return undefined
  if (chunk.name !== SESSION_ID_EVENT) return undefined
  const value: unknown = chunk.value
  if (value === null || typeof value !== 'object') return undefined
  const sessionId: unknown = Reflect.get(value, 'sessionId')
  return typeof sessionId === 'string' && sessionId !== ''
    ? sessionId
    : undefined
}
