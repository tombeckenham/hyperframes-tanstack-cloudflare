import { expect, test } from 'bun:test'
import { EventType } from '@tanstack/ai'
import { tailChunks } from './run-tail'
import type { TailSocket } from './run-tail'
import type { StreamChunk } from '@tanstack/ai'

type Handler = (event: {
  data?: unknown
  code?: number
  reason?: string
}) => void

/** A hand-rolled socket: exactly the TailSocket surface, driven by the test. */
class FakeSocket implements TailSocket {
  accepted = false
  closed = false
  private readonly handlers = new Map<string, Array<Handler>>()

  accept(): void {
    this.accepted = true
  }

  close(): void {
    this.closed = true
  }

  addEventListener(type: string, handler: Handler): void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
  }

  private emit(type: string, event: Parameters<Handler>[0]): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event)
  }

  frame(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) })
  }

  raw(data: unknown): void {
    this.emit('message', { data })
  }

  closeFromServer(code?: number, reason?: string): void {
    const event: Parameters<Handler>[0] = {}
    if (code !== undefined) event.code = code
    if (reason !== undefined) event.reason = reason
    this.emit('close', event)
  }

  errorFromServer(): void {
    this.emit('error', {})
  }
}

const chunk = (delta: string): StreamChunk => ({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: 'm1',
  delta,
})

/** Drain the generator fully, returning chunks (and rethrowing any failure). */
async function collect(
  generator: AsyncGenerator<StreamChunk>,
): Promise<Array<StreamChunk>> {
  const seen: Array<StreamChunk> = []
  for await (const item of generator) seen.push(item)
  return seen
}

/** Let queued microtasks (the pump's wake promises) run. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

test('yields chunks in order and ends cleanly on a status frame', async () => {
  const socket = new FakeSocket()
  const collecting = collect(tailChunks(socket, new AbortController().signal))
  await settle()
  socket.frame({ seq: 0, chunk: chunk('a') })
  socket.frame({ seq: 1, chunk: chunk('b') })
  socket.frame({ type: 'status', record: { status: 'done' } })
  socket.closeFromServer(1000)
  const seen = await collecting
  expect(seen.map((c) => Reflect.get(c, 'delta'))).toEqual(['a', 'b'])
  expect(socket.accepted).toBe(true)
  expect(socket.closed).toBe(true)
})

test('drains queued chunks before ending, even if status is already in', async () => {
  const socket = new FakeSocket()
  const generator = tailChunks(socket, new AbortController().signal)
  const collecting = collect(generator)
  await settle()
  // All frames land before the consumer gets another turn.
  socket.frame({ seq: 0, chunk: chunk('a') })
  socket.frame({ seq: 1, chunk: chunk('b') })
  socket.frame({ type: 'status', record: { status: 'done' } })
  const seen = await collecting
  expect(seen).toHaveLength(2)
})

test('ignores malformed and non-chunk frames', async () => {
  const socket = new FakeSocket()
  const collecting = collect(tailChunks(socket, new AbortController().signal))
  await settle()
  socket.raw('not json')
  socket.raw(42)
  socket.frame('a string frame')
  socket.frame({ seq: 0, chunk: { type: 'not-a-chunk' } })
  socket.frame({ seq: 1, chunk: chunk('real') })
  socket.frame({ type: 'status', record: { status: 'done' } })
  const seen = await collecting
  expect(seen).toHaveLength(1)
})

test('a close without a status frame throws, carrying code and reason', async () => {
  const socket = new FakeSocket()
  const collecting = collect(tailChunks(socket, new AbortController().signal))
  await settle()
  socket.frame({ seq: 0, chunk: chunk('a') })
  socket.closeFromServer(1011, 'tail failure')
  await expect(collecting).rejects.toThrow(
    'agent stream closed before the run finished (code 1011: tail failure)',
  )
})

test('a status record with status error throws its message after draining', async () => {
  const socket = new FakeSocket()
  const generator = tailChunks(socket, new AbortController().signal)
  const seen: Array<StreamChunk> = []
  const collecting = (async () => {
    for await (const item of generator) seen.push(item)
  })()
  await settle()
  socket.frame({ seq: 0, chunk: chunk('partial') })
  socket.frame({
    type: 'status',
    record: { status: 'error', error: { message: 'container died' } },
  })
  await expect(collecting).rejects.toThrow('container died')
  expect(seen).toHaveLength(1)
})

test('a socket error throws', async () => {
  const socket = new FakeSocket()
  const collecting = collect(tailChunks(socket, new AbortController().signal))
  await settle()
  socket.errorFromServer()
  await expect(collecting).rejects.toThrow('agent stream socket error')
})

test('an abort closes the socket and ends without throwing', async () => {
  const socket = new FakeSocket()
  const controller = new AbortController()
  const collecting = collect(tailChunks(socket, controller.signal))
  await settle()
  socket.frame({ seq: 0, chunk: chunk('a') })
  await settle()
  controller.abort()
  const seen = await collecting
  expect(seen).toHaveLength(1)
  expect(socket.closed).toBe(true)
})
