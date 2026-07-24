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
 * returned via exec stdout — the same bundle-over-stdout pattern
 * publishComposition already relies on (src/tools/publish.ts). NOT
 * `sandbox.containerFetch`: over the rpc-transport stub in local dev that
 * call never resolved, hanging the route (tested against live and dead ports
 * alike). The upstream's `/api/runtime.js` script tag will 404 on our
 * origin; that is fine — the player injects the runtime from its own CDN
 * when a composition needs one, and self-contained compositions are driven
 * through `__timelines` without it.
 *
 * TRUST, deliberately weighed: this serves LLM-authored HTML same-origin,
 * WITHOUT the `/p/*` CSP sandbox — the sandbox would give the document an
 * opaque origin and re-break the player (the whole reason `/p/*` never
 * worked in the player). The blast radius differs from `/p/*`: that is a
 * durable, shareable URL; this route derives `threadId` from the visitor's
 * OWN session cookie, so a composition is only ever served to the tenant
 * whose agent authored it. The exposure is "your own thread's agent runs
 * script in your page", accepted here as the cost of a working player —
 * the same trade the reference template ships.
 *
 * `port`/`project` come from the client (its ensure result). They only
 * select which port/path of the CALLER'S OWN container to read — the same
 * authority the caller already has through the agent — and are validated to
 * shapes that cannot escape that container.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getSandbox } from '@cloudflare/sandbox'
import { z } from 'zod'
import { deriveThreadId, resolveSession } from '../lib/session'

/** Must match every other getSandbox() for this id — see sandbox-provider.ts. */
const SANDBOX_OPTIONS = { transport: 'rpc' } as const

const searchSchema = z.object({
  threadKey: z.string().min(1).max(128),
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
              // `project` is regex-validated ([A-Za-z0-9._-]) and `port` is an
              // int, so neither can carry shell metacharacters. `-f` makes an
              // upstream error status an exec failure instead of an error page
              // served as a composition.
              const result = await sandbox.exec(
                `curl -sf --max-time 20 http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project)}/preview`,
              )
              if (!result.success || result.stdout.length === 0) {
                return new Response(
                  'the preview server did not return the composition — is it running?',
                  { status: 502 },
                )
              }
              const headers = new Headers({
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
                // Embeddable by our own pages (the player's iframe), nobody
                // else's.
                'content-security-policy': "frame-ancestors 'self'",
              })
              if (setCookie !== null) headers.set('set-cookie', setCookie)
              return new Response(result.stdout, { headers })
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
