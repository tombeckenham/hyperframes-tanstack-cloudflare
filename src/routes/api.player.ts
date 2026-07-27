/**
 * `GET /api/player?threadKey&port&project` — the live composition, proxied
 * through OUR origin for `<hyperframes-player>`.
 *
 * Why a proxy exists at all: the player drives a composition through
 * `iframe.contentWindow.__player` / `__timelines`, which requires the iframe
 * document to be SAME-ORIGIN with the page hosting the player. Pointing the
 * player at the sandbox's quick-tunnel URL (a different origin) renders a
 * black rectangle — the player cannot probe the document, and the
 * postMessage fallback needs a runtime handshake the preview route does not
 * guarantee. The reference template (hyperframes-cloudflare-template) does
 * exactly this: its player src is its own Worker's `/api/preview`.
 *
 * The upstream is the preview server's bundled-composition route
 * (`/api/projects/<project>/preview`), fetched with an in-container curl and
 * returned via exec stdout. NOT `sandbox.containerFetch`: over the
 * rpc-transport stub in local dev that call never resolved, hanging the route.
 *
 * Relative assets (images, fonts, …) resolve via `<base href>` to
 * `/api/player/media/...` (see `src/routes/api.player.media.$threadKey.$port.$project.$.ts`)
 * so the Worker can proxy them out of the same container without loading the
 * tunnel. The rewrite lives in `src/lib/player-proxy.ts`.
 *
 * TRUST: serves LLM-authored HTML same-origin without the `/p/*` CSP sandbox
 * (that would give an opaque origin and re-break the player). `threadId` is
 * derived from the visitor's session cookie — only their own thread.
 *
 * `port`/`project` come from the client (its ensure result). They only select
 * which port/path of the CALLER'S OWN container to read.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getSandbox } from '@cloudflare/sandbox'
import { z } from 'zod'
import {
  compositionCurlCommand,
  isPlayerThreadKey,
  rewritePlayerAssetBase,
} from '../lib/player-proxy'
import { deriveThreadId, resolveSession } from '../lib/session'

/** Must match every other getSandbox() for this id — see sandbox-provider.ts. */
const SANDBOX_OPTIONS = { transport: 'rpc' } as const

const searchSchema = z.object({
  // Same shape the media route enforces — a looser key here would serve a
  // composition whose rewritten asset URLs all 400 (a confusing half-failure).
  threadKey: z
    .string()
    .refine(isPlayerThreadKey, { message: 'invalid threadKey' }),
  port: z.coerce
    .number()
    .int()
    .min(1024)
    .max(65535)
    .refine((p) => p !== 3000, { message: 'port 3000 is the control plane' })
    .default(3002),
  project: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/u)
    .default('studio'),
})

export const Route = createFileRoute('/api/player')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          handler: async ({ request }) => {
            const url = new URL(request.url)
            const parsed = searchSchema.safeParse({
              threadKey: url.searchParams.get('threadKey') ?? undefined,
              port: url.searchParams.get('port') ?? undefined,
              project: url.searchParams.get('project') ?? undefined,
            })
            if (!parsed.success) {
              return new Response(
                parsed.error.issues[0]?.message ?? 'invalid query',
                { status: 400 },
              )
            }
            const { threadKey, port, project } = parsed.data

            const { sessionId, setCookie } = resolveSession(request)
            const threadId = await deriveThreadId(sessionId, threadKey)

            try {
              const sandbox = getSandbox(env.Sandbox, threadId, SANDBOX_OPTIONS)
              // `project` is regex-validated and `port` is an int — neither can
              // carry shell metacharacters. `-f` makes an upstream error status
              // an exec failure instead of an error page served as a composition.
              const result = await sandbox.exec(
                compositionCurlCommand(port, project),
              )
              if (!result.success || result.stdout.length === 0) {
                return new Response(
                  'the preview server did not return the composition — is it running?',
                  { status: 502 },
                )
              }
              const html = rewritePlayerAssetBase(
                result.stdout,
                threadKey,
                port,
                project,
              )
              const headers = new Headers({
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                // Embeddable by our own pages (the player's iframe), nobody
                // else's.
                'content-security-policy': "frame-ancestors 'self'",
              })
              if (setCookie !== null) headers.set('set-cookie', setCookie)
              return new Response(html, { headers })
            } catch (error) {
              console.error('[api/player] proxy error:', error)
              return new Response(
                error instanceof Error ? error.message : 'player proxy error',
                { status: 502 },
              )
            }
          },
        },
      }),
  },
})
