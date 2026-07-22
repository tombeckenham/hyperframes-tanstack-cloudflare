/**
 * `POST /api/run` — bridge the browser's `useChat` SSE expectation to the
 * sandbox agent's POST-then-WebSocket run protocol, in the same Worker.
 *
 * The run coordinator (the `RunCoordinator` DO wired by `src/server.ts`) speaks:
 *
 *   1. `startRun({ threadId, messages, … })` → `{ runId }` (returns
 *      immediately; the DO drives the run under its own `ctx.waitUntil`).
 *   2. `fetch('/runs/:runId/stream?threadId=…')` over a WebSocket → a resumable
 *      tail of `{ seq, chunk }` events, terminated by a `{ type: 'status' }`
 *      frame.
 *
 * `useChat` only speaks "POST a body, read back SSE", so this handler does the
 * handshake + WS tail and re-emits the chunks as SSE.
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
import { EventType, toServerSentEventsStream } from '@tanstack/ai'
import { z } from 'zod'
import { deriveThreadId, resolveSession } from '../lib/session'
import type { ModelMessage, StreamChunk } from '@tanstack/ai'
import type { StartRunInput } from '@tanstack/ai-sandbox-cloudflare/agent'

/** The layers `useChat` may nest forwarded props in, depending on the adapter. */
function bodyLayers(value: object): Array<object> {
  const layers: Array<object> = [value]
  if (
    'data' in value &&
    value.data !== null &&
    typeof value.data === 'object'
  ) {
    layers.push(value.data)
  }
  if (
    'forwardedProps' in value &&
    value.forwardedProps !== null &&
    typeof value.forwardedProps === 'object'
  ) {
    layers.push(value.forwardedProps)
  }
  return layers
}

/** First non-empty string for `key` across any body layer (top layer wins). */
function readForwarded(value: object, key: string): string | undefined {
  for (const layer of bodyLayers(value)) {
    const candidate: unknown = Reflect.get(layer, key)
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/**
 * The only browser-chosen field this app forwards. The upstream example also
 * carried harness/model pickers here; this app is single-harness, so they are
 * gone rather than ignored.
 */
const FORWARDED_KEYS = ['threadKey'] as const

/** Flatten the nested `data`/`forwardedProps` layers into one object. */
function flattenRunBody(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const flat: Record<string, unknown> = {}
  if ('messages' in value) flat['messages'] = value.messages
  for (const key of FORWARDED_KEYS) {
    const found = readForwarded(value, key)
    if (found !== undefined) flat[key] = found
  }
  return flat
}

const runBodySchema = z.preprocess(
  flattenRunBody,
  z.object({
    messages: z
      .array(z.custom<ModelMessage>())
      .min(1, 'body.messages must be a non-empty array'),
    /**
     * Client-chosen, one per chat thread, NOT a secret and NOT a thread id —
     * it only becomes one after being hashed with the visitor's session id.
     */
    threadKey: z.string().min(1).max(128),
  }),
)

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
async function getCoordinator(threadId: string) {
  // Dynamic import keeps the Workers-only `cloudflare:workers` virtual module
  // out of the client bundle (this handler only ever runs on the server).
  const { env } = await import('cloudflare:workers')
  return env.RUN_COORDINATOR.get(env.RUN_COORDINATOR.idFromName(threadId))
}

type Coordinator = Awaited<ReturnType<typeof getCoordinator>>

/**
 * The tail frames are JSON the coordinator wrote, so a malformed frame is a bug
 * there, not attacker input — but our lint (rightly) forbids the upstream
 * `parsed.chunk as StreamChunk`. `StreamChunk` is the AG-UI event union whose
 * discriminant is a string `type` drawn from the `EventType` enum; membership
 * in that enum is what a guard can honestly check.
 */
const STREAM_CHUNK_TYPES: ReadonlySet<string> = new Set(
  Object.values(EventType),
)

function isStreamChunk(value: unknown): value is StreamChunk {
  if (value === null || typeof value !== 'object') return false
  const type: unknown = Reflect.get(value, 'type')
  return typeof type === 'string' && STREAM_CHUNK_TYPES.has(type)
}

/**
 * Open the run's WebSocket tail (the coordinator's `fetch` returns a `101`
 * with a `webSocket`) and yield each `StreamChunk` as it arrives. Resolves when
 * the coordinator sends its terminal `status` frame (or the socket closes /
 * the client disconnects).
 */
async function* tailRun(
  coordinator: Coordinator,
  runId: string,
  threadId: string,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk> {
  // The host is irrelevant — the DO routes on the pathname; this is an
  // in-process DO `fetch`, not a public request.
  const streamUrl = `https://do/runs/${runId}/stream?threadId=${encodeURIComponent(threadId)}&lastSeq=-1`
  const res = await coordinator.fetch(streamUrl, {
    headers: { Upgrade: 'websocket' },
  })
  const socket = res.webSocket
  if (!socket) {
    throw new Error(
      `agent stream did not upgrade to a WebSocket (status ${res.status})`,
    )
  }
  socket.accept()

  const queue: Array<StreamChunk> = []
  // Mutated from the socket/abort callbacks below. Held on an object (rather
  // than bare `let`s) so the generator loop's checks aren't flagged constant.
  const state: { finished: boolean; failure: Error | null } = {
    finished: false,
    failure: null,
  }
  let wake: (() => void) | null = null
  const signalReady = () => {
    wake?.()
    wake = null
  }

  socket.addEventListener('message', (event: MessageEvent) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof event.data === 'string' ? event.data : '')
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    if ('type' in parsed && parsed.type === 'status') {
      state.finished = true
    } else if ('chunk' in parsed && isStreamChunk(parsed.chunk)) {
      queue.push(parsed.chunk)
    }
    signalReady()
  })
  socket.addEventListener('close', () => {
    state.finished = true
    signalReady()
  })
  socket.addEventListener('error', () => {
    state.failure = new Error('agent stream socket error')
    state.finished = true
    signalReady()
  })
  const onAbort = () => {
    state.finished = true
    try {
      socket.close()
    } catch {
      // already closing
    }
    signalReady()
  }
  signal.addEventListener('abort', onAbort)

  try {
    while (!state.finished || queue.length > 0) {
      const next = queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      // This IS the pump: the loop must park until a socket callback wakes it;
      // there is nothing to collect into a Promise.all.
      // oxlint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    if (state.failure) throw state.failure
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      socket.close()
    } catch {
      // already closed
    }
  }
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
              const coordinator = await getCoordinator(threadId)
              const input: StartRunInput = {
                runId: crypto.randomUUID(),
                threadId,
                messages,
                // Contract obligation 3: the host this request arrived on.
                // Coordinators derive the container's bridge + preview hosts
                // from it when PUBLIC_HOSTNAME / PREVIEW_HOSTNAME are unset
                // (local dev → host.docker.internal). Safe to trust on
                // Cloudflare: the edge only routes hostnames you own here.
                publicHost: new URL(request.url).host,
              }
              const { runId } = await coordinator.startRun(input)
              const chunks = tailRun(
                coordinator,
                runId,
                threadId,
                abortController.signal,
              )
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
