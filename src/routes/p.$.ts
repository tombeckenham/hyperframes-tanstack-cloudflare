/**
 * `GET /p/*` — serve a bundled, self-contained composition HTML out of R2.
 *
 * Two things make this route dangerous, and both are handled here rather than
 * left to the caller:
 *
 * 1. The key comes from the URL. Only the `previews/` prefix is servable —
 *    without that guard this route would also serve `tickets/<runId>/<name>`,
 *    whose body is a live upload bearer token.
 *
 * 2. The HTML was authored by an LLM. It is served with
 *    `Content-Security-Policy: sandbox allow-scripts`, which drops the document
 *    into an OPAQUE ORIGIN: inline scripts still run — `bundleToSingleHtml`
 *    inlines the runtime, so they must — but the page loses same-origin access
 *    to the studio. No localStorage, no cookies, no `parent.document`, no
 *    same-origin `fetch` of `/api/*`.
 *
 *    `frame-ancestors` alone was not enough: it only stops third parties
 *    framing the page, and does nothing when `/p/<key>` is opened directly as a
 *    top-level tab — where, being same-origin with the studio, the composition
 *    could otherwise read the transcript and call authenticated routes with the
 *    user's credentials.
 *
 *    `connect-src 'none'` is deliberate: a bundle is self-contained by
 *    construction, so it has no reason to reach the network, and blocking it
 *    closes the exfiltration path.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { PREVIEW_PREFIX, servableKey } from '../lib/artifact-keys'

const CSP = [
  'sandbox allow-scripts',
  "object-src 'none'",
  "connect-src 'none'",
  "frame-ancestors 'self'",
].join('; ')

const notFound = (): Response => new Response('not found', { status: 404 })

export const Route = createFileRoute('/p/$')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          handler: async ({ params }) => {
            const key = servableKey(params._splat, PREVIEW_PREFIX)
            if (key === null) return notFound()

            const object = await env.RENDERS.get(key)
            if (!object) return notFound()

            // Headers are set explicitly rather than via writeHttpMetadata:
            // the stored metadata is attacker-influenced, and this response
            // must not inherit a content-type or cache directive from it.
            const headers = new Headers()
            headers.set('content-type', 'text/html; charset=utf-8')
            headers.set('etag', object.httpEtag)
            // A composition is republished under the same key as it is edited,
            // so this must not be cached the way a render is.
            headers.set('cache-control', 'no-store')
            headers.set('content-security-policy', CSP)
            headers.set('x-content-type-options', 'nosniff')

            return new Response(object.body, { status: 200, headers })
          },
        },
      }),
  },
})
