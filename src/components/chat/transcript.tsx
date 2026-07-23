/**
 * The transcript: shadcn's `message-scroller` shell around `Message`/`Bubble`
 * turns. The scroller is the piece worth taking from the registry — it owns
 * anchored turns, streamed-reply autoscroll and jump-to-latest, exactly the
 * behaviour a multi-minute agent run needs.
 */
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { Message, MessageContent, MessageGroup } from '@/components/ui/message'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Marker, MarkerContent } from '@/components/ui/marker'
import { AssistantPartView } from './message-parts'
import { toolResultsById } from '@/lib/tool-urls'
import type { UIMessage } from '@tanstack/ai-react'

function UserTurn({ message }: { message: UIMessage }) {
  return (
    <Message align="end">
      <MessageContent>
        {message.parts.map((part, index) =>
          part.type === 'text' && part.content !== '' ? (
            // Parts carry no id; the stream only appends, so position IS identity.
            // oxlint-disable-next-line react/no-array-index-key
            <Bubble key={index} variant="default" align="end">
              <BubbleContent className="whitespace-pre-wrap">
                {part.content}
              </BubbleContent>
            </Bubble>
          ) : null,
        )}
      </MessageContent>
    </Message>
  )
}

function AssistantTurn({
  message,
  busy,
  onOptionSelect,
}: {
  message: UIMessage
  busy: boolean
  onOptionSelect: (text: string) => void
}) {
  const results = toolResultsById(message)
  return (
    <Message align="start">
      <MessageContent>
        {/* The part union has no COMMON id field (tool-call parts have one,
            text/thinking don't), and the stream only appends — so position is
            the only identity available. */}
        {/* oxlint-disable react/no-array-index-key */}
        {message.parts.map((part, index) => (
          <AssistantPartView
            key={index}
            part={part}
            results={results}
            busy={busy}
            onOptionSelect={onOptionSelect}
          />
        ))}
        {/* oxlint-enable react/no-array-index-key */}
      </MessageContent>
    </Message>
  )
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
      <p className="text-lg font-medium">HyperFrames Studio</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        Describe the video you want. The agent authors a HyperFrames composition
        in a sandbox, previews it live, and renders it to MP4.
      </p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Tip: messages starting with a slash invoke the agent&apos;s skills
        directly — try{' '}
        <code className="rounded bg-muted px-1">
          /hyperframes a 10s product teaser
        </code>
        .
      </p>
    </div>
  )
}

export function Transcript({
  messages,
  isLoading,
  error,
  onOptionSelect,
}: {
  messages: Array<UIMessage>
  isLoading: boolean
  /**
   * `useChat().error` — the ONLY surface a failed run has. The client never
   * adds an error part to the transcript (RUN_ERROR chunks land here instead),
   * so a page that drops this value shows a run that just… stops.
   */
  error: Error | undefined
  /** Sends an askUser card's chosen option as the next user message. */
  onOptionSelect: (text: string) => void
}) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller>
        <MessageScrollerViewport aria-label="Chat transcript">
          <MessageScrollerContent className="p-4">
            {messages.length === 0 ? <EmptyState /> : null}
            {messages.map((message) => (
              <MessageScrollerItem
                key={message.id}
                messageId={message.id}
                scrollAnchor={message.role === 'user'}
              >
                <MessageGroup>
                  {message.role === 'user' ? (
                    <UserTurn message={message} />
                  ) : (
                    <AssistantTurn
                      message={message}
                      busy={isLoading}
                      onOptionSelect={onOptionSelect}
                    />
                  )}
                </MessageGroup>
              </MessageScrollerItem>
            ))}
            {isLoading ? (
              <MessageScrollerItem>
                <Marker variant="separator">
                  <MarkerContent className="shimmer">
                    agent working…
                  </MarkerContent>
                </Marker>
              </MessageScrollerItem>
            ) : null}
            {error === undefined ? null : (
              <MessageScrollerItem>
                <Bubble variant="destructive">
                  <BubbleContent className="whitespace-pre-wrap">
                    Run failed: {error.message}
                  </BubbleContent>
                </Bubble>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
