/**
 * `PUT /api/uploads/:runId/:name` — the render upload lane.
 *
 * The sandbox streams a rendered MP4 straight in here and the body is piped
 * into R2 without ever being buffered by a tool. The alternative — reading the
 * file back over the sandbox fs bridge — is base64-over-exec, which is fine for
 * an HTML string and wasteful and memory-hungry for a video.
 *
 * Gated by a single-use ticket minted by `publishRender`. The route is
 * reachable by anything that can reach the Worker, so it validates:
 * ticket exists, not expired, token matches (constant time), and the target key
 * is the one the ticket was minted for — the caller never chooses the key.
 */
import { createFileRoute } from '@tanstack/react-router'
import { timingSafeBearerEqualWeb } from '@tanstack/ai-sandbox-cloudflare/agent'
import { env } from 'cloudflare:workers'
import { uploadTicketKey, uploadTicketSchema } from '../tools/publish'

/**
 * Ceiling on a single upload. A looping agent should not be able to push
 * unbounded bytes into R2 through one ticket, and R2's own single-object limit
 * is far higher than any composition render needs.
 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const Route = createFileRoute('/api/uploads/$runId/$name')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        PUT: {
          handler: async ({ request, params }) => {
            const { runId, name } = params

            const ticketKey = uploadTicketKey(runId, name)
            const stored = await env.RENDERS.get(ticketKey)
            if (!stored) {
              // Same response for "never existed" and "already used", so this
              // cannot be used to probe which runIds are real.
              return json({ error: 'invalid or expired upload ticket' }, 403)
            }

            const parsed = uploadTicketSchema.safeParse(await stored.json())
            if (!parsed.success) {
              await env.RENDERS.delete(ticketKey)
              return json({ error: 'malformed upload ticket' }, 500)
            }
            const ticket = parsed.data

            if (Date.now() > ticket.expiresAt) {
              await env.RENDERS.delete(ticketKey)
              return json({ error: 'invalid or expired upload ticket' }, 403)
            }

            const authorization = request.headers.get('authorization')
            if (
              !timingSafeBearerEqualWeb(
                authorization ?? undefined,
                ticket.token,
              )
            ) {
              return json({ error: 'invalid or expired upload ticket' }, 403)
            }

            if (!request.body) {
              return json({ error: 'request body is required' }, 400)
            }

            // curl -T sets Content-Length from stat, so this is present for the
            // intended caller. Requiring it also means R2 is never handed a
            // stream of unknown length, which fails opaquely.
            const declared = request.headers.get('content-length')
            if (declared === null) {
              return json({ error: 'content-length is required' }, 411)
            }
            const size = Number(declared)
            if (!Number.isFinite(size) || size <= 0) {
              return json({ error: 'invalid content-length' }, 400)
            }
            if (size > MAX_UPLOAD_BYTES) {
              return json({ error: 'upload too large' }, 413)
            }

            // Burn the ticket BEFORE the upload. A retry then needs a fresh
            // publishRender call, which is the safer failure direction: a
            // replay cannot overwrite an object that already published.
            await env.RENDERS.delete(ticketKey)

            // The key comes from the ticket, never from the request, so a
            // caller cannot redirect the write somewhere else.
            await env.RENDERS.put(ticket.targetKey, request.body, {
              httpMetadata: {
                contentType: ticket.contentType,
                cacheControl: 'public, max-age=31536000, immutable',
              },
            })

            return json({ ok: true, url: `/r/${ticket.targetKey}` }, 201)
          },
        },
      }),
  },
})
