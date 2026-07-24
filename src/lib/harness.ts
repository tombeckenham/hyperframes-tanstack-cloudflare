/**
 * In-sandbox coding-agent selection.
 *
 * The image ships both CLIs (`claude` and `grok`). Selection is host-side and
 * automatic from the Worker's secrets — no UI picker:
 *
 *   - `XAI_API_KEY` set → Grok Build (wins if both keys are set)
 *   - else `ANTHROPIC_API_KEY` set → Claude Code
 *   - else fail early
 *
 * Only the chosen harness's key is injected into the container.
 */

export const HARNESS_NAMES = ['grok', 'claude-code'] as const

export type HarnessName = (typeof HARNESS_NAMES)[number]

/** CUSTOM stream event each harness emits so follow-up runs can `--resume`. */
export const HARNESS_SESSION_ID_EVENT: Record<HarnessName, string> = {
  grok: 'grok-build.session-id',
  'claude-code': 'claude-code.session-id',
}

const SESSION_ID_EVENTS = new Set<string>(
  Object.values(HARNESS_SESSION_ID_EVENT),
)

export interface HarnessEnv {
  ANTHROPIC_API_KEY?: string
  XAI_API_KEY?: string
}

function hasKey(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

/**
 * Pick the harness for this Worker from which API key is present.
 * `XAI_API_KEY` wins when both are set.
 */
export function resolveHarness(env: HarnessEnv): HarnessName {
  if (hasKey(env.XAI_API_KEY)) return 'grok'
  if (hasKey(env.ANTHROPIC_API_KEY)) return 'claude-code'
  throw new Error(
    'No agent API key is set. Set XAI_API_KEY (Grok Build) or ANTHROPIC_API_KEY (Claude Code) in .dev.vars for local dev, or `wrangler secret put` the same name for a deployed Worker.',
  )
}

/** Workspace secrets injected for the selected harness only. */
export function harnessSecrets(env: HarnessEnv): Record<string, string> {
  const harness = resolveHarness(env)
  if (harness === 'grok') {
    const key = env.XAI_API_KEY
    // resolveHarness already requires this; narrow for the type system.
    if (!hasKey(key)) {
      throw new Error('grok harness needs XAI_API_KEY.')
    }
    return { XAI_API_KEY: key }
  }
  const key = env.ANTHROPIC_API_KEY
  if (!hasKey(key)) {
    throw new Error('claude-code harness needs ANTHROPIC_API_KEY.')
  }
  return { ANTHROPIC_API_KEY: key }
}

/**
 * Read a harness session id from a stream chunk. Accepts either harness's
 * event name so the client does not need to know which CLI the host selected.
 *
 * Takes narrow fields rather than `StreamChunk` so this module stays free of
 * a hard `@tanstack/ai` import at the type boundary used by tests and the client.
 */
export function readAgentSessionId(
  chunk: {
    type: string
    name?: string | undefined
    value?: unknown
  },
  eventTypeCustom: string,
): string | undefined {
  if (chunk.type !== eventTypeCustom) return undefined
  const name = chunk.name
  if (name === undefined || !SESSION_ID_EVENTS.has(name)) {
    return undefined
  }
  const value: unknown = chunk.value
  if (value === null || typeof value !== 'object') return undefined
  const sessionId: unknown = Reflect.get(value, 'sessionId')
  return typeof sessionId === 'string' && sessionId !== ''
    ? sessionId
    : undefined
}
