/**
 * `POST /api/run` — bridge the browser's `useChat` SSE expectation to the
 * sandbox agent's POST-then-WebSocket run protocol, in the same Worker.
 *
 * The run coordinator (the `RunCoordinator` DO wired by `src/server.ts`) speaks:
 *
 *   1. `startRun({ threadId, messages, … })` → `{ runId }` (returns
 *      immediately; the DO drives the run under its own `ctx.waitUntil`).
 *   2. `fetch('/runs/:runId/stream')` over a WebSocket → a resumable tail of
 *      `{ seq, chunk }` events, terminated by a `{ type: 'status' }` frame.
 *
 * `useChat` only speaks "POST a body, read back SSE", so this handler does the
 * handshake and re-emits the tail as SSE (the pump itself lives in
 * `src/lib/run-tail.ts`, the body contract in `src/lib/run-body.ts`).
 *
 * The coordinator is addressed over the `RUN_COORDINATOR` **binding**, never
 * `fetch('/runs')` — a Worker fetching its own hostname is a same-zone
 * self-subrequest, which Cloudflare blocks in production (error 1042 → 404)
 * even though it resolves fine in local `workerd`. And `/runs` is not routed
 * publicly at all: the package's trigger takes `threadId` straight from the
 * body, unauthenticated (see src/server.ts).
 *
 * Three obligations no type can enforce (CLAUDE.md "The /api/run contract"):
 *   1. `threadId` comes from `deriveThreadId(sessionId, threadKey)` — NEVER
 *      from the body. The branded `ThreadId` makes the raw-string version fail
 *      to compile, but only this route can pick the inputs correctly.
 *   2. `resolveSession`'s `setCookie` is attached to the response when non-null,
 *      or a first-time visitor gets a fresh namespace on every request.
 *   3. `publicHost` is passed to `startRun` — the package's `/runs` route used
 *      to capture it and we removed that route, so it is now this caller's job.
 *      Omitting it typechecks, deploys, and then fails at the container's first
 *      bridge callback (a 404 read as "the tanstack MCP server hasn't come up").
 */
import { createFileRoute } from '@tanstack/react-router'
import { createMiddleware } from '@tanstack/react-start'
import { toServerSentEventsStream } from '@tanstack/ai'
import { env } from 'cloudflare:workers'
import { deriveThreadId, resolveSession } from '../lib/session'
import { runBodySchema } from '../lib/run-body'
import { tailChunks } from '../lib/run-tail'
import type { StreamChunk } from '@tanstack/ai'
import type { StartRunInput } from '@tanstack/ai-sandbox-cloudflare/agent'
import type { ThreadId } from '../lib/session'

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Request middleware: parse + validate the body once and hand the typed result
 * to the POST handler via context, short-circuiting with a 4xx on a bad
 * request so the handler only ever sees a valid `runBody`.
 */
const runBodyMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    if (request.signal.aborted) {
      return new Response(null, { status: 499 })
    }
    let raw: unknown
    try {
      raw = await request.json()
    } catch {
      return jsonError(400, 'invalid JSON body')
    }
    const parsed = runBodySchema.safeParse(raw)
    if (!parsed.success) {
      return jsonError(400, parsed.error.issues[0]?.message ?? 'invalid body')
    }
    return next({ context: { runBody: parsed.data } })
  },
)

/** The run coordinator DO for a thread, over the `RUN_COORDINATOR` binding. */
const getCoordinator = (threadId: ThreadId) =>
  env.RUN_COORDINATOR.get(env.RUN_COORDINATOR.idFromName(threadId))

type Coordinator = ReturnType<typeof getCoordinator>

/**
 * Open the run's WebSocket tail (the coordinator's `fetch` returns a `101`
 * with a `webSocket`) and hand it to the pump.
 */
async function* tailRun(
  coordinator: Coordinator,
  runId: string,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk> {
  // The host is irrelevant — the DO routes on the pathname; this is an
  // in-process DO `fetch`, not a public request. `lastSeq=-1` replays the run
  // from the start.
  const streamUrl = `https://do/runs/${runId}/stream?lastSeq=-1`
  const res = await coordinator.fetch(streamUrl, {
    headers: { Upgrade: 'websocket' },
  })
  const socket = res.webSocket
  if (!socket) {
    throw new Error(
      `agent stream did not upgrade to a WebSocket (status ${res.status})`,
    )
  }
  yield* tailChunks(socket, signal)
}

export const Route = createFileRoute('/api/run')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: {
          middleware: [runBodyMiddleware],
          handler: async ({ request, context }) => {
            const { messages, threadKey } = context.runBody

            // Contract obligations 1 and 2: derive, never trust; persist the
            // session a first-time visitor was just minted.
            const { sessionId, setCookie } = resolveSession(request)
            const threadId = await deriveThreadId(sessionId, threadKey)

            const abortController = new AbortController()
            request.signal.addEventListener('abort', () =>
              abortController.abort(),
            )

            try {
              const coordinator = getCoordinator(threadId)
              const input: StartRunInput = {
                runId: crypto.randomUUID(),
                threadId,
                messages,
                // Contract obligation 3: the host this request arrived on.
                // The coordinator derives the container's bridge origin (and
                // the render-upload URL) from it when PUBLIC_HOSTNAME is unset
                // (local dev → host.docker.internal). Safe to trust on
                // Cloudflare: the edge only routes hostnames you own here.
                publicHost: new URL(request.url).host,
              }
              const { runId } = await coordinator.startRun(input)
              const chunks = tailRun(coordinator, runId, abortController.signal)
              const sseStream = toServerSentEventsStream(
                chunks,
                abortController,
              )
              const headers = new Headers({
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              })
              if (setCookie !== null) headers.set('set-cookie', setCookie)
              return new Response(sseStream, { headers })
            } catch (error) {
              if (abortController.signal.aborted) {
                return new Response(null, { status: 499 })
              }
              console.error('[api/run] proxy error:', error)
              return jsonError(
                502,
                error instanceof Error ? error.message : 'proxy error',
              )
            }
          },
        },
      }),
  },
})
