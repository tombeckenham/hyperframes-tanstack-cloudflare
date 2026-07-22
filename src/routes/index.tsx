/**
 * The studio: transcript + composer on the left, preview pane on the right.
 *
 * Thread identity, client side: the URL search param `thread` is the
 * `threadKey` — client-chosen, one per chat thread, NOT a secret and NOT a
 * thread id. It goes to `/api/run` in the body, where it is hashed with the
 * visitor's HttpOnly session cookie into the real `threadId`
 * (src/lib/session.ts). Keeping it in the URL means a reload resumes the same
 * sandbox (`lifecycle: { reuse: 'thread' }`) and the same artifact namespace.
 */
import { useCallback, useEffect, useMemo } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import { MoonIcon, PlusIcon, SunIcon } from 'lucide-react'
import { z } from 'zod'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable'
import { Button } from '@/components/ui/button'
import { Transcript } from '@/components/chat/transcript'
import { Composer } from '@/components/chat/composer'
import { latestArtifactUrls } from '@/lib/tool-urls'
import { PreviewPane } from '@/components/studio/preview-pane'
import { toggleTheme } from '@/lib/theme'

const searchSchema = z.object({
  /** The threadKey. Length-capped to match the server's schema. */
  thread: z.string().min(1).max(128).optional(),
})

export const Route = createFileRoute('/')({
  validateSearch: (search) => searchSchema.parse(search),
  component: Studio,
})

const newThreadKey = (): string => crypto.randomUUID().slice(0, 13)

// Stable across renders: recreating the connection adapter would rebuild the
// chat client mid-stream.
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
  const forwardedProps = useMemo(() => ({ threadKey }), [threadKey])

  const { messages, sendMessage, isLoading, stop, clear } = useChat({
    connection,
    forwardedProps,
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

  const handleStop = useCallback(() => {
    void stop()
  }, [stop])

  const startNewThread = useCallback(() => {
    clear()
    void navigate({ search: { thread: newThreadKey() } })
  }, [clear, navigate])

  if (thread === undefined) return null

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
      {/* react-resizable-panels v4: string sizes are percentages; numbers
          would be pixels. Orientation defaults to horizontal. */}
      <ResizablePanelGroup className="min-h-0 flex-1">
        <ResizablePanel defaultSize="45" minSize="25">
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <Transcript messages={messages} isLoading={isLoading} />
            </div>
            <div className="border-t border-border p-3">
              <Composer
                onSend={handleSend}
                onStop={handleStop}
                isLoading={isLoading}
              />
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="55" minSize="25">
          <PreviewPane
            previewUrl={previewUrl}
            compositionUrl={compositionUrl}
            threadKey={threadKey}
          />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
