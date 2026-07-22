/**
 * The right pane: three tabs over the three artifact surfaces.
 *
 *   Live    — the sandbox's `hyperframes preview` studio through its Cloudflare
 *             quick tunnel (`*.trycloudflare.com`), a plain iframe.
 *   Player  — the last published composition (`/p/<key>`) inside
 *             `<hyperframes-player>`. The `/p/*` response carries
 *             `Content-Security-Policy: sandbox allow-scripts`, so the document
 *             keeps an opaque origin regardless of the player's inner iframe
 *             attributes — the CSP can only be tightened by an embedder, never
 *             loosened.
 *   Renders — the thread's published MP4s out of R2, via `/api/artifacts`.
 */
import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCwIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
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

function RendersTab({ threadKey }: { threadKey: string }) {
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
  previewUrl,
  compositionUrl,
  threadKey,
}: {
  previewUrl: string | null
  compositionUrl: string | null
  threadKey: string
}) {
  // The custom element touches `customElements` at registration, so it must
  // only ever load in the browser — never during SSR module evaluation. If the
  // chunk fails to load, the element would sit inert and the tab would show
  // black nothing — surface that instead.
  const [playerFailed, setPlayerFailed] = useState(false)
  useEffect(() => {
    import('@hyperframes/player').catch(() => {
      setPlayerFailed(true)
    })
  }, [])

  return (
    <Tabs defaultValue="live" className="flex h-full min-h-0 flex-col">
      <TabsList className="mx-3 mt-3 self-start">
        <TabsTrigger value="live">Live</TabsTrigger>
        <TabsTrigger value="player">Player</TabsTrigger>
        <TabsTrigger value="renders">Renders</TabsTrigger>
      </TabsList>
      <TabsContent value="live" className="min-h-0 flex-1">
        {previewUrl === null ? (
          <Placeholder>
            No live preview yet. Once the agent starts `hyperframes preview` in
            the sandbox, its tunnel appears here.
          </Placeholder>
        ) : (
          // No sandbox attribute: the tunnel is a different site entirely
          // (*.trycloudflare.com), so the browser's origin isolation already
          // applies — and the preview studio is a full Vite app that needs
          // scripts AND its own origin, the exact combination the lint rule
          // (rightly, for same-origin embeds) refuses inside `sandbox`.
          // oxlint-disable-next-line react/iframe-missing-sandbox
          <iframe
            src={previewUrl}
            title="Live sandbox preview"
            className="size-full border-0"
          />
        )}
      </TabsContent>
      <TabsContent value="player" className="min-h-0 flex-1">
        {playerFailed ? (
          <Placeholder>
            The player script failed to load — reload the page to retry.
          </Placeholder>
        ) : compositionUrl === null ? (
          <Placeholder>
            No published composition yet. The agent publishes one with the
            publishComposition tool.
          </Placeholder>
        ) : (
          <div className="flex size-full items-center justify-center bg-black/90 p-3">
            <hyperframes-player
              src={compositionUrl}
              controls
              className="max-h-full w-full"
            />
          </div>
        )}
      </TabsContent>
      <TabsContent value="renders" className="min-h-0 flex-1">
        <RendersTab threadKey={threadKey} />
      </TabsContent>
    </Tabs>
  )
}
