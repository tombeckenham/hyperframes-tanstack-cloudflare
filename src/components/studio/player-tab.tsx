/**
 * The Player tab: the thread's LIVE composition — authored, not yet rendered —
 * inside `<hyperframes-player>`, with proper transport controls and
 * frame-accurate scrubbing.
 *
 * The source is `/api/player` — OUR OWN origin, proxying the preview server's
 * bundled-composition route out of the container (see src/routes/api.player.ts
 * for why: the player drives the composition through `contentWindow`, which a
 * cross-origin tunnel URL forbids; pointing it at the tunnel renders black).
 * The full studio UI is NOT embedded here; the header's "Hyperframes Studio"
 * button opens it in its own window.
 *
 * This tab also owns the session lifecycle states (starting spinner, ensure
 * failure, stopped-with-resume), since it is the surface a user watches while
 * the sandbox comes up or after it slept. The refresh button re-mounts the
 * player against the current composition — the proxied document is a
 * snapshot, not a hot-reloading page.
 */
import { useEffect, useState } from 'react'
import { Loader2Icon, RefreshCwIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PreviewSession } from '@/hooks/use-preview-session'

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      {children}
    </div>
  )
}

export function PlayerTab({
  session,
  threadKey,
}: {
  session: PreviewSession
  threadKey: string
}) {
  // The custom element touches `customElements` at registration, so it must
  // only ever load in the browser — never during SSR module evaluation. If
  // the chunk fails to load, the element would sit inert and the tab would
  // show black nothing — surface that instead.
  const [playerFailed, setPlayerFailed] = useState(false)
  useEffect(() => {
    import('@hyperframes/player').catch(() => {
      setPlayerFailed(true)
    })
  }, [])

  if (playerFailed) {
    return (
      <Centered>
        <p className="text-sm text-muted-foreground">
          The player script failed to load — reload the page to retry.
        </p>
      </Centered>
    )
  }

  if (session.url === null) {
    if (session.error !== null) {
      return (
        <Centered>
          <p className="text-sm text-muted-foreground">
            The preview could not start ({session.error}).
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={session.resume}
            disabled={session.resuming}
          >
            {session.resuming ? 'Starting…' : 'Try again'}
          </Button>
        </Centered>
      )
    }
    return (
      <Centered>
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Starting the preview sandbox — a cold boot can take up to a minute.
        </p>
      </Centered>
    )
  }

  if (session.stopped) {
    return (
      <Centered>
        <p className="text-sm font-medium">The preview has stopped.</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          The sandbox goes to sleep after inactivity. Published compositions and
          renders are safe; anything unpublished lived on its ephemeral disk.
        </p>
        <Button size="sm" onClick={session.resume} disabled={session.resuming}>
          {session.resuming ? (
            <>
              <Loader2Icon className="animate-spin" /> Resuming…
            </>
          ) : (
            'Resume preview'
          )}
        </Button>
        {session.error !== null && !session.resuming ? (
          <p className="text-xs text-destructive">{session.error}</p>
        ) : null}
      </Centered>
    )
  }

  // Same-origin on purpose — see the module comment. The session's port and
  // project ride along so the proxy asks the right server for the right
  // project without rediscovering either. `v` keys the src on the session's
  // composition version, which bumps automatically when an agent turn
  // finishes — so the player re-pulls the composition without anyone
  // touching the refresh button.
  const src =
    `/api/player?threadKey=${encodeURIComponent(threadKey)}` +
    `&port=${session.port}&project=${encodeURIComponent(session.project)}` +
    `&v=${session.compositionVersion}`
  return (
    <div className="relative size-full bg-black p-3">
      {/* Explicit size is load-bearing: the element's internals are all
          position:absolute, so it has NO intrinsic height — anything less
          than a sized box renders a 0px-tall player ("rescale no-op after
          ready — zero-size player element" in the console). The player
          letterboxes the composition inside whatever box it gets. */}
      <hyperframes-player
        key={src}
        src={src}
        controls
        className="block size-full"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={session.refreshComposition}
        aria-label="Reload the composition"
        className="absolute top-2 right-2 text-white/70 hover:text-white"
      >
        <RefreshCwIcon />
      </Button>
    </div>
  )
}
