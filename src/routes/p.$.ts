/**
 * `GET /p/*` — serve a bundled, self-contained composition HTML out of R2.
 *
 * This HTML was authored by an LLM inside the sandbox, so it is served with a
 * restrictive CSP. `frame-ancestors 'self'` lets our own studio iframe it while
 * denying everyone else, and `object-src 'none'` removes the plugin surface.
 *
 * Note what the CSP deliberately does NOT do: `bundleToSingleHtml` inlines the
 * HyperFrames runtime and the composition's own scripts and styles, so a
 * `script-src` without `'unsafe-inline'` would break every published
 * composition. Isolation comes from this being a distinct path on the origin
 * plus the sandboxed iframe the studio embeds it in, not from script-src.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

export const Route = createFileRoute('/p/$')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          handler: async ({ params }) => {
            const key = params._splat
            if (key === undefined || key === '') {
              return new Response('not found', { status: 404 })
            }

            const object = await env.RENDERS.get(key)
            if (!object) return new Response('not found', { status: 404 })

            const headers = new Headers()
            object.writeHttpMetadata(headers)
            headers.set('content-type', 'text/html; charset=utf-8')
            headers.set('etag', object.httpEtag)
            // A composition is republished under the same key as it is edited,
            // so this must not be cached the way a render is.
            headers.set('cache-control', 'no-store')
            headers.set(
              'content-security-policy',
              "frame-ancestors 'self'; object-src 'none'",
            )
            headers.set('x-content-type-options', 'nosniff')

            return new Response(object.body, { status: 200, headers })
          },
        },
      }),
  },
})
