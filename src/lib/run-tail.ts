/**
 * The WebSocket-tail pump: consume the coordinator's `{ seq, chunk }` frames
 * and yield each `StreamChunk` until the terminal `{ type: 'status', record }`
 * frame (or the socket dies, or the client goes away).
 *
 * Extracted from the `/api/run` route behind structural types so the subtlest
 * code in the bridge is testable with a hand-rolled fake socket — CLAUDE.md
 * expects first-run integration bugs exactly here, and unit tests are how the
 * pump gets ruled out while debugging the real thing.
 *
 * Failure semantics (each verified against the coordinator source):
 *  - A normal end is `status` frame then close(1000). The status record for a
 *    failed run carries `status: 'error'` — surfaced as a thrown Error so the
 *    SSE layer emits a RUN_ERROR frame instead of ending "successfully".
 *  - A close WITHOUT a status frame is abnormal (the coordinator closes 1011
 *    on a tail failure, with no status) — also surfaced as a thrown Error.
 *    Without this, the client adapter synthesizes RUN_FINISHED and a dead DO
 *    looks like a clean completion.
 *  - A client abort is neither: the consumer is gone, nothing to report.
 */
import { isStreamChunk } from './stream-chunk'
import type { StreamChunk } from '@tanstack/ai'

/** The slice of a WebSocket the pump touches — Cloudflare's satisfies it. */
export interface TailSocket {
  accept(): void
  close(): void
  addEventListener(
    type: 'message',
    handler: (event: { data?: unknown }) => void,
  ): void
  addEventListener(
    type: 'close',
    handler: (event: { code?: number; reason?: string }) => void,
  ): void
  addEventListener(type: 'error', handler: () => void): void
}

/** The slice of AbortSignal the pump touches. */
export interface TailAbortSignal {
  readonly aborted: boolean
  addEventListener(type: 'abort', handler: () => void): void
  removeEventListener(type: 'abort', handler: () => void): void
}

/** A terminal status record's failure, if the record reports one. */
function statusFailure(record: unknown): Error | null {
  if (record === null || typeof record !== 'object') return null
  if (Reflect.get(record, 'status') !== 'error') return null
  const error: unknown = Reflect.get(record, 'error')
  const message: unknown =
    error !== null && typeof error === 'object'
      ? Reflect.get(error, 'message')
      : undefined
  return new Error(
    typeof message === 'string' && message !== ''
      ? message
      : 'the run ended in an error',
  )
}

export async function* tailChunks(
  socket: TailSocket,
  signal: TailAbortSignal,
): AsyncGenerator<StreamChunk> {
  socket.accept()

  const queue: Array<StreamChunk> = []
  // Mutated from the socket/abort callbacks below. Held on an object (rather
  // than bare `let`s) so the generator loop's checks aren't flagged constant.
  const state: {
    finished: boolean
    sawStatus: boolean
    failure: Error | null
  } = { finished: false, sawStatus: false, failure: null }
  let wake: (() => void) | null = null
  const signalReady = () => {
    wake?.()
    wake = null
  }

  socket.addEventListener('message', (event) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(typeof event.data === 'string' ? event.data : '')
    } catch {
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    if ('type' in parsed && parsed.type === 'status') {
      state.sawStatus = true
      state.failure ??= statusFailure(Reflect.get(parsed, 'record'))
      state.finished = true
    } else if ('chunk' in parsed && isStreamChunk(parsed.chunk)) {
      queue.push(parsed.chunk)
    }
    signalReady()
  })
  socket.addEventListener('close', (event) => {
    if (!state.sawStatus && !signal.aborted) {
      const reason =
        typeof event.reason === 'string' && event.reason !== ''
          ? `: ${event.reason}`
          : ''
      state.failure ??= new Error(
        `agent stream closed before the run finished (code ${event.code ?? 'unknown'}${reason})`,
      )
    }
    state.finished = true
    signalReady()
  })
  socket.addEventListener('error', () => {
    state.failure ??= new Error('agent stream socket error')
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
    if (state.failure && !signal.aborted) throw state.failure
  } finally {
    signal.removeEventListener('abort', onAbort)
    try {
      socket.close()
    } catch {
      // already closed
    }
  }
}
