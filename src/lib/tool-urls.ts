/**
 * Digging artifact URLs out of the transcript.
 *
 * Host tools return `{ url }` (exposePreview) or `{ ok, url }` (publish*), but
 * by the time a value reaches the browser it may be that object, a JSON string
 * of it, or an MCP content array of `{ type: 'text', text }` blocks — the
 * transport is not ours to pin down. Pure functions, no JSX, so the UI logic
 * that matters most is testable without a DOM.
 */
import type {
  MessagePart,
  ToolResultPart,
  UIMessage,
} from '@tanstack/ai-client'

const isToolResultPart = (part: MessagePart): part is ToolResultPart =>
  part.type === 'tool-result'

/** Fold a message's `tool-result` parts into a map keyed by the call id. */
export function toolResultsById(
  message: UIMessage,
): Map<string, ToolResultPart> {
  const results = new Map<string, ToolResultPart>()
  for (const part of message.parts) {
    if (isToolResultPart(part)) results.set(part.toolCallId, part)
  }
  return results
}

/** Dig a URL out of a host tool's output, wherever the transport put it. */
export function extractToolUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try {
      return extractToolUrl(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractToolUrl(entry)
      if (found !== null) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const url: unknown = Reflect.get(value, 'url')
  if (typeof url === 'string' && url !== '') return url
  const text: unknown = Reflect.get(value, 'text')
  if (typeof text === 'string') return extractToolUrl(text)
  const content: unknown = Reflect.get(value, 'content')
  if (content !== undefined && content !== value) return extractToolUrl(content)
  return null
}

/**
 * Dig a *failure* out of a host tool's output. The publish tools report
 * failure as an ordinary result — `{ ok: false, error: '…' }` with tool state
 * still `complete` — so a UI that only looks at the part's `state` renders a
 * failed publish as success. Same transport tolerance as {@link extractToolUrl}.
 */
export function extractToolError(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    try {
      return extractToolError(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = extractToolError(entry)
      if (found !== null) return found
    }
    return null
  }
  if (typeof value !== 'object') return null
  const error: unknown = Reflect.get(value, 'error')
  const errorText = typeof error === 'string' && error !== '' ? error : null
  if (Reflect.get(value, 'ok') === false) {
    return errorText ?? 'tool reported failure'
  }
  if (errorText !== null) return errorText
  const text: unknown = Reflect.get(value, 'text')
  if (typeof text === 'string') return extractToolError(text)
  const content: unknown = Reflect.get(value, 'content')
  if (content !== undefined && content !== value) {
    return extractToolError(content)
  }
  return null
}

/**
 * Walk the whole transcript for the newest preview-tunnel and published-
 * composition URLs. Tool names are matched by suffix: in `do-drives` mode the
 * host tools reach the in-sandbox agent over MCP, and MCP-speaking harnesses
 * prefix server tool names (`mcp__<server>__exposePreview`), so an exact match
 * would silently never fire.
 */
export function latestArtifactUrls(messages: Array<UIMessage>): {
  previewUrl: string | null
  compositionUrl: string | null
} {
  let previewUrl: string | null = null
  let compositionUrl: string | null = null
  for (const message of messages) {
    const results = toolResultsById(message)
    for (const part of message.parts) {
      if (part.type !== 'tool-call') continue
      const output: unknown = part.output ?? results.get(part.id)?.content
      const url = extractToolUrl(output)
      if (url === null) continue
      // Both destinations are allowlisted by shape: the tunnel is always
      // https, and a composition must live under the /p/ route. Anything else
      // out of a tool result never becomes an iframe/player src.
      if (part.name.endsWith('exposePreview') && url.startsWith('https://')) {
        previewUrl = url
      }
      if (part.name.endsWith('publishComposition') && url.startsWith('/p/')) {
        compositionUrl = url
      }
    }
  }
  return { previewUrl, compositionUrl }
}
