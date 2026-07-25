/**
 * Client half of the harness session round-trip: each adapter announces its
 * run session as a CUSTOM chunk (`claude-code.session-id` or
 * `grok-build.session-id`); the studio remembers it per thread and echoes it
 * in the next run's body, which the coordinator turns into `--resume`. That
 * keeps the in-sandbox agent's working context — loaded skills, read files,
 * interview state — alive across turns.
 *
 * The client does not know which harness the host selected (auto by key), so
 * both event names are accepted.
 */
import { EventType } from '@tanstack/ai'
import { readAgentSessionId } from './harness'
import type { StreamChunk } from '@tanstack/ai'

/** Read the session id out of a stream chunk, or undefined for other chunks. */
export function readClaudeSessionId(chunk: StreamChunk): string | undefined {
  return readAgentSessionId(chunk, EventType.CUSTOM)
}
