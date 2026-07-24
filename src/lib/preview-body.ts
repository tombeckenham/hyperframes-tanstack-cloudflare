/**
 * The `/api/preview` contract — request body and response shapes, shared
 * between the preview pane and the server route (the `run-body.ts` pattern:
 * validate at the boundary, share the types).
 *
 * Two actions, deliberately asymmetric in cost:
 *
 *   ensure — boots (or reuses) the thread's sandbox, makes sure the baked
 *            starter project and the `hyperframes preview` server exist, and
 *            returns a verified tunnel URL. This WAKES the container and is
 *            billed accordingly; the UI calls it on load and on explicit
 *            resume, never on a poll.
 *   probe  — asks the Worker to fetch a tunnel URL and report whether the
 *            edge could reach the origin. No sandbox involvement at all: a
 *            slept container's cloudflared is dead, so the edge answers
 *            5xx/refuses and the probe reports it WITHOUT waking anything.
 *            This is the one the UI polls.
 */
import { z } from 'zod'

/**
 * Only quick-tunnel URLs may be probed. The probe makes the Worker fetch a
 * caller-supplied URL, which without this shape check would be an open
 * server-side request proxy.
 */
export function isPreviewTunnelUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' && url.hostname.endsWith('.trycloudflare.com')
  )
}

export const previewBodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('ensure'),
    /** Client-chosen thread name — hashed with the session id server-side. */
    threadKey: z.string().min(1).max(128),
  }),
  z.object({
    action: z.literal('probe'),
    url: z.string().max(2048).refine(isPreviewTunnelUrl, {
      message: 'url must be an https *.trycloudflare.com tunnel URL',
    }),
  }),
])

export type PreviewBody = z.infer<typeof previewBodySchema>

export type PreviewEnsureResponse =
  | {
      ok: true
      url: string
      port: number
      /**
       * The project the preview server is serving (`projectName` from its
       * `/__hyperframes_config`). The player plays the live composition at
       * `<url>/api/projects/<project>/preview`, and the name is not
       * hard-codable: the agent may legitimately serve a different project
       * than the baked `studio` (the recipe allows a re-init for e.g.
       * Tailwind scaffolds).
       */
      project: string
    }
  | { ok: false; error: string }

export interface PreviewProbeResponse {
  healthy: boolean
}
