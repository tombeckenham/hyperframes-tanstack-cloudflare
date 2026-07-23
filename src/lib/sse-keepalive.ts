/**
 * SSE keep-alive: inject comment frames (`: keep-alive\n\n`) into a byte
 * stream whenever the source goes quiet.
 *
 * Why this exists: an agent run emits chunks only when the model produces
 * output, so a long tool execution is minutes of TCP silence — and mobile
 * browsers (WebKit especially) kill idle fetches, which surfaces in the UI as
 * the run "failing" with `Load failed` while the coordinator keeps running
 * fine. SSE comments are ignored by every spec-compliant parser (the client's
 * adapter explicitly skips `:`-prefixed lines), so they keep bytes flowing
 * without ever becoming chunks.
 */

const HEARTBEAT = new TextEncoder().encode(': keep-alive\n\n')

/** 15s: comfortably inside the ~30-60s idle windows mobile browsers enforce. */
export const KEEPALIVE_INTERVAL_MS = 15_000

export function withSseKeepAlive(
  source: ReadableStream<Uint8Array>,
  intervalMs: number = KEEPALIVE_INTERVAL_MS,
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  let timer: ReturnType<typeof setInterval> | null = null
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(HEARTBEAT)
        } catch {
          // The stream closed between ticks; the pump below is what stops us.
          stopTimer()
        }
      }, intervalMs)

      void (async () => {
        try {
          for (;;) {
            // Sequential by nature: a stream pump reads one chunk at a time.
            // oxlint-disable-next-line no-await-in-loop
            const { value, done } = await reader.read()
            if (done) break
            controller.enqueue(value)
          }
          stopTimer()
          controller.close()
        } catch (error) {
          stopTimer()
          controller.error(error)
        }
      })()
    },
    cancel(reason) {
      stopTimer()
      return reader.cancel(reason)
    },
  })
}
