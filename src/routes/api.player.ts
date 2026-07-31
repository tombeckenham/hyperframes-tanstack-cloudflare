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
 * The upstream's `/api/runtime.js` script tag 404s on our origin — intentional;
 * the player injects runtime from its CDN when needed, and self-contained
 * compositions run through `__timelines` without it.
 *
 * Relative assets (images, fonts, …) resolve via `<base href>` to
 * `/api/player/media/...` (see `src/routes/api.player.media.$threadKey.$port.$project.$.ts`)
 * so the Worker can proxy them out of the same container without loading the
 * tunnel. The rewrite lives in `src/lib/player-proxy.ts`.
 *
 * TRUST: serves LLM-authored HTML same-origin without the `/p/*` CSP sandbox
 * (that would give an opaque origin and re-break the player). `threadId` is
 * derived from the visitor's session cookie — only their own thread. Blast
 * radius differs from durable `/p/*` URLs: exposure is "your agent runs script
 * in your page", accepted as the cost of a working player.
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
  isPlayerPort,
  isPlayerProject,
  isPlayerThreadKey,
  playerProxyResponse,
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
    .refine(isPlayerPort, { message: 'invalid port' })
    .default(3002),
  project: z
    .string()
    .refine(isPlayerProject, { message: 'invalid project' })
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
                const detail =
                  `${result.stderr}\n${result.stdout}`.trim() || 'no output'
                console.error('[api/player] composition fetch failed:', detail)
                return playerProxyResponse(
                  'the preview server did not return the composition — is it running?',
                  502,
                  { 'content-type': 'text/plain; charset=utf-8' },
                  setCookie,
                )
              }
              const html = rewritePlayerAssetBase(
                result.stdout,
                threadKey,
                port,
                project,
              )
              return playerProxyResponse(
                html,
                200,
                {
                  'content-type': 'text/html; charset=utf-8',
                  'cache-control': 'no-store',
                  // Embeddable by our own pages (the player's iframe), nobody
                  // else's.
                  'content-security-policy': "frame-ancestors 'self'",
                },
                setCookie,
              )
            } catch (error) {
              console.error('[api/player] proxy error:', error)
              return playerProxyResponse(
                error instanceof Error ? error.message : 'player proxy error',
                502,
                { 'content-type': 'text/plain; charset=utf-8' },
                setCookie,
              )
            }
          },
        },
      }),
  },
})
