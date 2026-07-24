/**
 * One-line summaries for tool-call chips in the transcript.
 *
 * A collapsed row reading just "Bash" tells the user nothing; "Bash npx
 * hyperframes check" tells them what the agent is doing without expanding
 * anything. The mapping is by tool name with a generic fallback, tolerant of
 * MCP prefixes (`mcp__<server>__exposePreview`) and of arguments that are
 * still streaming (partial JSON → no summary yet; the chip falls back to the
 * bare name until the call completes).
 */

/** Parse a tool call's `arguments` JSON into a plain object, or null. */
function parseArguments(argumentsJson: string): object | null {
  if (argumentsJson === '') return null
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
      return null
    return parsed
  } catch {
    return null
  }
}

/** Collapse whitespace so multi-line commands stay a one-line chip. */
const oneLine = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim()

/** Paths inside the sandbox are noisy; show them workspace-relative. */
const trimPath = (path: string): string =>
  path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : path

export function toolCallSummary(
  name: string,
  argumentsJson: string,
): string | null {
  const args = parseArguments(argumentsJson)
  if (args === null) return null

  const str = (key: string): string | null => {
    const value: unknown = Reflect.get(args, key)
    return typeof value === 'string' && value.trim() !== ''
      ? oneLine(value)
      : null
  }

  if (name === 'Bash') return str('description') ?? str('command')
  if (
    name === 'Read' ||
    name === 'Write' ||
    name === 'Edit' ||
    name === 'MultiEdit' ||
    name === 'NotebookEdit'
  ) {
    const path = str('file_path')
    return path === null ? null : trimPath(path)
  }
  if (name === 'Skill') {
    const skill = str('skill')
    if (skill === null) return null
    const skillArgs = str('args')
    return skillArgs === null ? `/${skill}` : `/${skill} ${skillArgs}`
  }
  if (name === 'Glob' || name === 'Grep') return str('pattern')
  if (name === 'WebFetch' || name === 'WebSearch')
    return str('url') ?? str('query')
  if (name === 'Task') return str('description')
  if (name.endsWith('exposePreview')) {
    const port: unknown = Reflect.get(args, 'port')
    return typeof port === 'number' ? `port ${port}` : null
  }
  if (name.endsWith('hyperframesRecipe')) return str('section')

  // Generic fallback: the first non-empty string argument is usually the
  // subject of the call.
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value)
  }
  return null
}
