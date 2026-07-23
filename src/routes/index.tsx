/**
 * The studio. Two layouts over one state:
 *   - desktop (md+): transcript + composer left, preview pane right, resizable.
 *   - mobile: one column, top-level Chat | Preview tabs — the preview pane
 *     keeps its own Live/Player/Renders tabs inside the Preview tab.
 *
 * Thread identity, client side: the URL search param `thread` is the
 * `threadKey` — client-chosen, one per chat thread, NOT a secret and NOT a
 * thread id. It goes to `/api/run` in the body, where it is hashed with the
 * visitor's HttpOnly session cookie into the real `threadId`
 * (src/lib/session.ts). Keeping it in the URL means a reload resumes the same
 * sandbox (`lifecycle: { reuse: 'thread' }`) and the same artifact namespace.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import { MoonIcon, PlusIcon, SunIcon } from 'lucide-react'
import { z } from 'zod'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Transcript } from '@/components/chat/transcript'
import { Composer } from '@/components/chat/composer'
import { latestArtifactUrls } from '@/lib/tool-urls'
import { localChatPersistence } from '@/lib/chat-persistence'
import { readClaudeSessionId } from '@/lib/claude-session'
import type { StreamChunk } from '@tanstack/ai'
import { PreviewPane } from '@/components/studio/preview-pane'
import { toggleTheme } from '@/lib/theme'
import { useIsDesktop } from '@/hooks/use-is-desktop'
import type { UIMessage } from '@tanstack/ai-react'

const searchSchema = z.object({
  /** The threadKey. Length-capped to match the server's schema. */
  thread: z.string().min(1).max(128).optional(),
})

export const Route = createFileRoute('/')({
  validateSearch: (search) => searchSchema.parse(search),
  component: Studio,
})

const newThreadKey = (): string => crypto.randomUUID().slice(0, 13)

// Hoisted for clarity, not necessity: useChat reads `connection` once at
// client construction (its memo is keyed on the client id alone), so a fresh
// adapter per render would be silently IGNORED — hoisting makes the actual
// lifetime obvious. `forwardedProps` below is the reactive one.
const connection = fetchServerSentEvents('/api/run')

function Studio() {
  const { thread } = Route.useSearch()
  const navigate = Route.useNavigate()

  // First visit: mint a threadKey into the URL so a reload resumes the thread.
  useEffect(() => {
    if (thread === undefined) {
      void navigate({
        search: { thread: newThreadKey() },
        replace: true,
      })
    }
  }, [thread, navigate])

  const threadKey = thread ?? ''

  // The claude-code session echo (src/lib/claude-session.ts): remembered per
  // thread for the life of the page, sent back so the coordinator can
  // `--resume` and the agent keeps its working context across turns.
  // Deliberately NOT persisted: the session lives on the container's
  // ephemeral disk, so a saved id would go stale across cold starts.
  const [agentSessionId, setAgentSessionId] = useState<string | undefined>(
    undefined,
  )
  useEffect(() => {
    setAgentSessionId(undefined)
  }, [threadKey])
  const handleChunk = useCallback((chunk: StreamChunk) => {
    const sessionId = readClaudeSessionId(chunk)
    if (sessionId !== undefined) setAgentSessionId(sessionId)
  }, [])

  const forwardedProps = useMemo(
    () =>
      agentSessionId !== undefined
        ? { threadKey, sessionId: agentSessionId }
        : { threadKey },
    [threadKey, agentSessionId],
  )

  // `id` keys both the chat client and its persisted transcript: switching
  // threads swaps clients, and each hydrates its own thread's messages from
  // localStorage — the client-side mirror of `lifecycle: { reuse: 'thread' }`.
  const { messages, sendMessage, isLoading, stop, error } = useChat({
    connection,
    forwardedProps,
    id: `thread-${threadKey}`,
    persistence: localChatPersistence,
    onChunk: handleChunk,
  })

  const { previewUrl, compositionUrl } = useMemo(
    () => latestArtifactUrls(messages),
    [messages],
  )

  const handleSend = useCallback(
    (text: string) => {
      void sendMessage(text)
    },
    [sendMessage],
  )

  // No clear() here: the id change swaps in a fresh client, and clearing
  // would persist an empty transcript over the OLD thread's saved one.
  const startNewThread = useCallback(() => {
    void navigate({ search: { thread: newThreadKey() } })
  }, [navigate])

  const isDesktop = useIsDesktop()

  if (thread === undefined) return null

  const chat = (
    <ChatColumn
      messages={messages}
      isLoading={isLoading}
      error={error}
      onSend={handleSend}
      onStop={stop}
      onOptionSelect={handleSend}
    />
  )
  const preview = (
    <PreviewPane
      previewUrl={previewUrl}
      compositionUrl={compositionUrl}
      threadKey={threadKey}
    />
  )

  return (
    <div className="flex h-dvh flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-2">
        <h1 className="text-sm font-semibold">HyperFrames Studio</h1>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={startNewThread}
            aria-label="New thread"
          >
            <PlusIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            aria-label="Toggle theme"
          >
            <SunIcon className="dark:hidden" />
            <MoonIcon className="hidden dark:block" />
          </Button>
        </div>
      </header>
      {isDesktop ? (
        /* react-resizable-panels v4: string sizes are percentages; numbers
           would be pixels. Orientation defaults to horizontal. */
        <ResizablePanelGroup className="min-h-0 flex-1">
          <ResizablePanel defaultSize="45" minSize="25">
            {chat}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize="55" minSize="25">
            {preview}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <Tabs defaultValue="chat" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-3 mt-2 self-start">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="min-h-0 flex-1">
            {chat}
          </TabsContent>
          <TabsContent value="preview" className="min-h-0 flex-1">
            {preview}
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}

function ChatColumn({
  messages,
  isLoading,
  error,
  onSend,
  onStop,
  onOptionSelect,
}: {
  messages: Array<UIMessage>
  isLoading: boolean
  error: Error | undefined
  onSend: (text: string) => void
  onStop: () => void
  onOptionSelect: (text: string) => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <Transcript
          messages={messages}
          isLoading={isLoading}
          error={error}
          onOptionSelect={onOptionSelect}
        />
      </div>
      <div className="border-t border-border p-3">
        <Composer onSend={onSend} onStop={onStop} isLoading={isLoading} />
      </div>
    </div>
  )
}
