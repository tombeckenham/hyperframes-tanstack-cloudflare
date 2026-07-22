/**
 * `GET /r/*` — serve a rendered MP4 out of R2.
 *
 * Only the `renders/` prefix is servable. Without that guard this route would
 * serve any key in the bucket, which is worse than it first sounds: it would
 * hand out `tickets/<runId>/<name>` (a live upload bearer token), AND it would
 * re-serve a published composition from `previews/` — restoring its stored
 * `text/html` content-type while applying none of the `/p/*` sandbox CSP,
 * neatly bypassing the isolation that route exists to provide.
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
import { RENDER_PREFIX, servableKey } from '../lib/artifact-keys'

const notFound = (): Response => new Response('not found', { status: 404 })

export const Route = createFileRoute('/r/$')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          handler: async ({ request, params }) => {
            const key = servableKey(params._splat, RENDER_PREFIX)
            if (key === null) return notFound()

            // Probe for the size first: a range cannot be resolved without it.
            const head = await env.RENDERS.head(key)
            if (!head) return notFound()

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

            if (!object) return notFound()

            const headers = new Headers()
            object.writeHttpMetadata(headers)
            headers.set('etag', object.httpEtag)
            headers.set('accept-ranges', 'bytes')
            // NOT immutable: `renderKey` is renders/<threadId>/<name> with an
            // agent-chosen name, so re-rendering and republishing under the
            // same name is the normal edit loop. A year-long immutable cache
            // would pin the first version in every browser and edge node with
            // no way to bust it. Revalidation against the ETag is cheap.
            headers.set('cache-control', 'public, max-age=60, must-revalidate')

            // Sizes come from `object`, not the earlier `head`: a republish
            // landing between the two calls would otherwise produce a
            // content-length that disagrees with the body being streamed,
            // which truncates or hangs the download.
            if (range === null) {
              headers.set('content-length', String(object.size))
              return new Response(object.body, { status: 200, headers })
            }

            const start =
              object.range && 'offset' in object.range
                ? object.range.offset
                : range.offset
            const length = range.length
            headers.set('content-length', String(length))
            headers.set(
              'content-range',
              `bytes ${start}-${start + length - 1}/${head.size}`,
            )
            return new Response(object.body, { status: 206, headers })
          },
        },
      }),
  },
})
