/**
 * The thread's live-preview session, shared by everything that needs the
 * tunnel: the header's "Preview Studio" button (opens the studio in its own
 * window), and the Player tab (plays the live composition and owns the
 * starting/stopped/resume states).
 *
 * Two calls with deliberately different costs (see src/routes/api.preview.ts):
 * `ensure` boots the sandbox and is called once per thread plus explicit
 * resumes; `probe` is the cheap poll that detects a slept sandbox without
 * waking it. The active URL is last-writer-wins between the ensure result and
 * the transcript (the agent's own exposePreview results, which may mint a NEW
 * tunnel mid-run after restarting the server).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  PreviewEnsureResponse,
  PreviewProbeResponse,
} from '@/lib/preview-body'

async function requestEnsure(
  threadKey: string,
): Promise<{ url: string; port: number; project: string }> {
  const response = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'ensure', threadKey }),
  })
  let body: PreviewEnsureResponse
  try {
    body = (await response.json()) as PreviewEnsureResponse
  } catch {
    throw new Error(`preview request ${response.status}`)
  }
  if (!body.ok) throw new Error(body.error)
  return { url: body.url, port: body.port, project: body.project }
}

async function requestProbe(url: string): Promise<boolean> {
  const response = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'probe', url }),
  })
  if (!response.ok) throw new Error(`probe request ${response.status}`)
  const body = (await response.json()) as PreviewProbeResponse
  return body.healthy
}

/** How often the tunnel is re-checked (foreground tabs only). */
const PROBE_INTERVAL_MS = 45_000

export interface PreviewSession {
  /** The live tunnel URL, once known. */
  url: string | null
  /** The project the preview server is serving — player URLs need it. */
  project: string
  /** The in-container port the preview server answered on. */
  port: number
  /** The initial ensure is in flight and no URL is known yet. */
  starting: boolean
  /** The health poll says the tunnel is dead (the sandbox slept). */
  stopped: boolean
  /** A resume (ensure re-run) is in flight. */
  resuming: boolean
  /** The last ensure failure, if any. */
  error: string | null
  /** Re-run ensure: boots the sandbox and re-establishes the tunnel. */
  resume: () => void
  /**
   * Monotonic version of the composition as far as the UI knows. Bumped when
   * an agent turn finishes (the composition has usually changed by then) and
   * by {@link refreshComposition}; the Player keys its src on it, so a bump
   * re-fetches and re-mounts against the composition as it exists now.
   */
  compositionVersion: number
  /** Manual bump — the Player tab's refresh button. */
  refreshComposition: () => void
}

export function usePreviewSession(
  threadKey: string,
  transcriptPreviewUrl: string | null,
  /** True while an agent run is streaming (useChat's isLoading). */
  runActive: boolean,
): PreviewSession {
  // One ensure per thread, plus explicit resumes. Deliberately never
  // refetched on focus/reconnect/poll: ensure WAKES the container (and bills
  // for it) — health checks go through the probe below instead.
  const ensure = useQuery({
    queryKey: ['preview-ensure', threadKey],
    queryFn: () => requestEnsure(threadKey),
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const { refetch: refetchEnsure } = ensure

  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  useEffect(() => {
    setActiveUrl(null)
  }, [threadKey])
  const ensuredUrl = ensure.data?.url ?? null
  useEffect(() => {
    if (ensuredUrl !== null) setActiveUrl(ensuredUrl)
  }, [ensuredUrl])
  useEffect(() => {
    if (transcriptPreviewUrl !== null) setActiveUrl(transcriptPreviewUrl)
  }, [transcriptPreviewUrl])

  // The Worker-side health probe — detects a slept sandbox WITHOUT waking it.
  // `dataUpdatedAt` in the key restarts the probe after a resume even when
  // the re-established tunnel keeps the same URL.
  const probe = useQuery({
    queryKey: ['preview-probe', activeUrl, ensure.dataUpdatedAt],
    enabled: activeUrl !== null,
    queryFn: () => {
      if (activeUrl === null) throw new Error('no preview url')
      return requestProbe(activeUrl)
    },
    refetchInterval: PROBE_INTERVAL_MS,
    retry: false,
  })

  const resume = useCallback(() => {
    void refetchEnsure()
  }, [refetchEnsure])

  // "The agent finished" needs no tool or server signal: a run ending closes
  // the SSE stream and flips runActive. Bumping the version then re-pulls the
  // composition — and since askUser approval gates also end the turn, this
  // fires at exactly the "come look at it" moments. A bump when nothing
  // changed just re-fetches a few hundred KB from the local proxy: harmless.
  const [compositionVersion, setCompositionVersion] = useState(0)
  const wasRunActive = useRef(runActive)
  useEffect(() => {
    if (wasRunActive.current && !runActive) {
      setCompositionVersion((version) => version + 1)
    }
    wasRunActive.current = runActive
  }, [runActive])

  const refreshComposition = useCallback(() => {
    setCompositionVersion((version) => version + 1)
  }, [])

  return {
    url: activeUrl,
    project: ensure.data?.project ?? 'studio',
    port: ensure.data?.port ?? 3002,
    starting: activeUrl === null && ensure.isPending,
    stopped: probe.data === false,
    resuming: ensure.isFetching,
    error: ensure.isError
      ? ensure.error instanceof Error
        ? ensure.error.message
        : 'preview request failed'
      : null,
    resume,
    compositionVersion,
    refreshComposition,
  }
}
