/**
 * HTTP `Range` parsing for the R2-backed MP4 route.
 *
 * Lives apart from the route so it can be tested without pulling in
 * `cloudflare:workers`. It is the part most likely to be subtly wrong, and the
 * failure mode — a video that will not scrub in Safari — is easy to miss.
 */

export interface ByteRange {
  offset: number
  length: number
}

/**
 * Parse a single-range `bytes=` header against a known object size.
 *
 * Returns:
 *  - `null` when there is no range, or the header is malformed or multi-range.
 *    The caller should serve the whole object with `200`.
 *  - `'unsatisfiable'` when the range cannot be met. The caller should answer
 *    `416` with `content-range: bytes *\/<size>`.
 *  - a `ByteRange` to pass straight to `R2Bucket.get(key, { range })`.
 */
export function parseRange(
  header: string | null,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (header === null) return null

  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (!match) return null

  const [, rawStart, rawEnd] = match
  const hasStart = rawStart !== undefined && rawStart !== ''
  const hasEnd = rawEnd !== undefined && rawEnd !== ''

  if (!hasStart && !hasEnd) return null

  // `bytes=-N` — the final N bytes.
  if (!hasStart) {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable'
    const length = Math.min(suffix, size)
    return { offset: size - length, length }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable'

  // An absent or past-EOF end clamps to the last byte, which is what
  // `bytes=0-` (Safari's opening probe) relies on.
  const end = hasEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable'

  return { offset: start, length: end - start + 1 }
}
