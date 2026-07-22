/**
 * `GET /r/*` — serve a rendered MP4 out of R2.
 *
 * Range-aware, deliberately. The reference template does a plain
 * `R2Bucket.get(key)` and returns the whole body: Safari will not scrub — and
 * in some cases will not play at all — a `<video>` whose server does not answer
 * range requests, so the gallery needs this.
 *
 * A splat route rather than `$key`, because the keys are paths
 * (`renders/<threadId>/<name>.mp4`) and a single param will not match slashes.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { parseRange } from '../lib/range'

export const Route = createFileRoute('/r/$')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          handler: async ({ request, params }) => {
            const key = params._splat
            if (key === undefined || key === '') {
              return new Response('not found', { status: 404 })
            }

            // HEAD-equivalent probe first: we need the size to resolve a range
            // before asking R2 for the bytes.
            const head = await env.RENDERS.head(key)
            if (!head) return new Response('not found', { status: 404 })

            const range = parseRange(request.headers.get('range'), head.size)

            if (range === 'unsatisfiable') {
              return new Response('range not satisfiable', {
                status: 416,
                headers: { 'content-range': `bytes */${head.size}` },
              })
            }

            const object =
              range === null
                ? await env.RENDERS.get(key)
                : await env.RENDERS.get(key, { range })

            if (!object) return new Response('not found', { status: 404 })

            const headers = new Headers()
            object.writeHttpMetadata(headers)
            headers.set('etag', object.httpEtag)
            headers.set('accept-ranges', 'bytes')
            // Keys are unique per publish, so immutable is safe.
            headers.set('cache-control', 'public, max-age=31536000, immutable')

            if (range === null) {
              headers.set('content-length', String(head.size))
              return new Response(object.body, { status: 200, headers })
            }

            headers.set('content-length', String(range.length))
            headers.set(
              'content-range',
              `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`,
            )
            return new Response(object.body, { status: 206, headers })
          },
        },
      }),
  },
})
