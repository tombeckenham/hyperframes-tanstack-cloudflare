import { expect, test } from 'bun:test'
import { withSseKeepAlive } from './sse-keepalive'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  for (;;) {
    // Sequential by nature: a stream pump reads one chunk at a time.
    // oxlint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read()
    if (done) return out
    out += decoder.decode(value)
  }
}

test('passes source bytes through and closes with the source', async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"a":1}\n\n'))
      controller.enqueue(encoder.encode('data: {"b":2}\n\n'))
      controller.close()
    },
  })
  const out = await readAll(withSseKeepAlive(source, 60_000))
  expect(out).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n')
})

test('injects comment heartbeats while the source is quiet', async () => {
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      await gate
      controller.enqueue(encoder.encode('data: {"late":true}\n\n'))
      controller.close()
    },
  })
  const wrapped = withSseKeepAlive(source, 10)
  const reading = readAll(wrapped)
  await new Promise((resolve) => setTimeout(resolve, 50))
  release?.()
  const out = await reading
  expect(out).toContain(': keep-alive\n\n')
  expect(out).toContain('data: {"late":true}\n\n')
  // Heartbeats are comments — nothing that a data-line parser would consume.
  const dataLines = out.split('\n').filter((l) => l.startsWith('data:'))
  expect(dataLines).toHaveLength(1)
})

test('propagates a source error', async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('upstream died'))
    },
  })
  await expect(readAll(withSseKeepAlive(source, 60_000))).rejects.toThrow(
    'upstream died',
  )
})

test('cancel stops the heartbeat and cancels the source', async () => {
  let cancelled = false
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true
    },
  })
  const wrapped = withSseKeepAlive(source, 10)
  const reader = wrapped.getReader()
  await reader.cancel('client left')
  expect(cancelled).toBe(true)
})
