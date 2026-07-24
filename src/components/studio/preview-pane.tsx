/**
 * The right pane: two tabs over the thread's two video surfaces.
 *
 *   Player  — the LIVE composition (authored, not yet rendered) played in
 *             `<hyperframes-player>` straight off the preview server's tunnel;
 *             also owns the session's starting/stopped/resume states — see
 *             src/components/studio/player-tab.tsx. The full studio UI is not
 *             embedded anywhere; the header's "Preview Studio" button opens it
 *             in its own window.
 *   Renders — what the thread has published to R2, via `/api/artifacts`:
 *             MP4s inline, bundled compositions (`/p/<key>`) as links.
 */
import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { PlayerTab } from '@/components/studio/player-tab'
import type { PreviewSession } from '@/hooks/use-preview-session'
import type { ArtifactList } from '@/routes/api.artifacts'

function Placeholder({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

async function fetchArtifacts(threadKey: string): Promise<ArtifactList> {
  const response = await fetch(
    `/api/artifacts?threadKey=${encodeURIComponent(threadKey)}`,
  )
  if (!response.ok) throw new Error(`artifacts request ${response.status}`)
  return (await response.json()) as ArtifactList
}

export function RendersTab({ threadKey }: { threadKey: string }) {
  const query = useQuery({
    queryKey: ['artifacts', threadKey],
    queryFn: () => fetchArtifacts(threadKey),
  })

  const refresh = useCallback(() => {
    void query.refetch()
  }, [query])

  const renders = query.data?.renders ?? []
  const compositions = query.data?.compositions ?? []

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">
          {renders.length} render{renders.length === 1 ? '' : 's'},{' '}
          {compositions.length} composition
          {compositions.length === 1 ? '' : 's'}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={refresh}
          aria-label="Refresh gallery"
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {/* A failed list must NOT render as an empty gallery: "nothing
          published yet" is an actively wrong instruction when publishes exist
          and only the listing broke. */}
      {query.isError ? (
        <Placeholder>
          {`Could not load the gallery (${
            query.error instanceof Error
              ? query.error.message
              : 'request failed'
          }). Use the refresh button to retry.`}
        </Placeholder>
      ) : null}
      {!query.isError && renders.length === 0 && compositions.length === 0 ? (
        <Placeholder>
          Nothing published yet. Ask the agent to render the composition and it
          will land here.
        </Placeholder>
      ) : null}
      {renders.map((render) => (
        <figure key={render.key} className="flex flex-col gap-1">
          <video
            src={render.url}
            controls
            preload="metadata"
            className="w-full rounded-lg border border-border bg-black"
          />
          <figcaption className="flex justify-between text-xs text-muted-foreground">
            <a href={render.url} className="underline underline-offset-2">
              {render.key.split('/').at(-1)}
            </a>
            <span>{(render.bytes / (1024 * 1024)).toFixed(1)} MB</span>
          </figcaption>
        </figure>
      ))}
      {compositions.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {compositions.map((composition) => (
            <li key={composition.key}>
              <a
                href={composition.url}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {composition.key.split('/').at(-1)}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function PreviewPane({
  session,
  threadKey,
}: {
  session: PreviewSession
  threadKey: string
}) {
  return (
    <Tabs defaultValue="player" className="flex h-full min-h-0 flex-col">
      <TabsList className="mx-3 mt-3 self-start">
        <TabsTrigger value="player">Player</TabsTrigger>
        <TabsTrigger value="renders">Renders</TabsTrigger>
      </TabsList>
      <TabsContent value="player" className="min-h-0 flex-1">
        <PlayerTab session={session} threadKey={threadKey} />
      </TabsContent>
      <TabsContent value="renders" className="min-h-0 flex-1">
        <RendersTab threadKey={threadKey} />
      </TabsContent>
    </Tabs>
  )
}
