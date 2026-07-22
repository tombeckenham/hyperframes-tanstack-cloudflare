/**
 * The one piece of real UI logic in the chat: map TanStack AI's `MessagePart`
 * union onto the shadcn chat shells. No adapter layer — the shadcn chat
 * components render children, not a message model, so the union is switched
 * right here and nowhere else.
 *
 * `tool-result` parts are not rendered directly: they are folded into a
 * per-message map first (see {@link toolResultsById}) and shown inside the
 * originating `tool-call`'s panel, which is how a reader actually thinks about
 * a call/result pair.
 */
import { useMemo, useState } from 'react'
import { ChevronRightIcon } from 'lucide-react'
import { ThinkingPart as ThinkingPartView } from '@tanstack/ai-react-ui'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Spinner } from '@/components/ui/spinner'
import { extractToolUrl } from '@/lib/tool-urls'
import type { MessagePart, ToolResultPart } from '@tanstack/ai-client'

/** The untyped `tool-call` member of the part union, as narrowing yields it. */
type ToolCallPartOf = Extract<MessagePart, { type: 'tool-call' }>

/** Pretty-print a JSON-ish payload for the tool panel body. */
function formatPayload(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return value
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const TOOL_DONE_STATES = new Set(['complete', 'error'])

function ToolCallBubble({
  part,
  result,
}: {
  part: ToolCallPartOf
  result: ToolResultPart | undefined
}) {
  const [open, setOpen] = useState(false)

  // The untyped part's `arguments`/`output` are `any` in the lib; pin them to
  // safe types at the boundary instead of letting `any` spread.
  const args: string = typeof part.arguments === 'string' ? part.arguments : ''
  const output: unknown = part.output ?? result?.content
  const running = !TOOL_DONE_STATES.has(part.state) && result === undefined
  const failed = part.state === 'error' || result?.state === 'error'
  const url = useMemo(() => extractToolUrl(output), [output])

  const body = useMemo(() => {
    const sections: Array<string> = []
    if (args !== '') {
      sections.push(formatPayload(args))
    }
    if (output !== undefined) sections.push(formatPayload(output))
    return sections.join('\n\n')
  }, [args, output])

  return (
    <Bubble variant={failed ? 'destructive' : 'outline'}>
      <BubbleContent className="p-0">
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs">
            <ChevronRightIcon
              className="size-3.5 shrink-0 transition-transform data-[open]:rotate-90"
              data-open={open ? '' : undefined}
            />
            <span className="font-medium">{part.name}</span>
            {running ? <Spinner className="size-3.5" /> : null}
            {failed ? <span className="text-destructive">failed</span> : null}
            {url !== null ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="ml-auto truncate underline underline-offset-2"
                onClick={stopPropagation}
              >
                {url}
              </a>
            ) : null}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="max-h-72 overflow-auto border-t border-border px-3 py-2 font-mono text-xs whitespace-pre-wrap">
              {body}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </BubbleContent>
    </Bubble>
  )
}

// Hoisted: an inline arrow in the JSX would trip react-perf, and the handler
// has no per-instance state to close over. Structurally typed so no React
// namespace import is needed under the automatic JSX runtime.
function stopPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation()
}

/** Render one part of an assistant message. Returns null for consumed parts. */
export function AssistantPartView({
  part,
  results,
}: {
  part: MessagePart
  results: Map<string, ToolResultPart>
}) {
  switch (part.type) {
    case 'text':
      return part.content === '' ? null : (
        <Bubble variant="ghost">
          <BubbleContent className="whitespace-pre-wrap">
            {part.content}
          </BubbleContent>
        </Bubble>
      )
    case 'thinking':
      return part.content.trim() === '' ? null : (
        <ThinkingPartView
          content={part.content}
          className="rounded-xl bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
        />
      )
    case 'tool-call':
      return <ToolCallBubble part={part} result={results.get(part.id)} />
    default:
      return null
  }
}
