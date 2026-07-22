import { expect, test } from 'bun:test'
import { parseRange } from './range'

const SIZE = 1000

test('no range header serves the whole object', () => {
  expect(parseRange(null, SIZE)).toBeNull()
})

test('explicit byte ranges', () => {
  expect(parseRange('bytes=0-499', SIZE)).toEqual({ offset: 0, length: 500 })
  expect(parseRange('bytes=500-999', SIZE)).toEqual({
    offset: 500,
    length: 500,
  })
})

test('open-ended range runs to the last byte', () => {
  // `bytes=0-` is the probe Safari opens a <video> with; getting this wrong is
  // why a video plays but will not scrub.
  expect(parseRange('bytes=0-', SIZE)).toEqual({ offset: 0, length: 1000 })
  expect(parseRange('bytes=500-', SIZE)).toEqual({ offset: 500, length: 500 })
})

test('suffix range takes the final N bytes', () => {
  expect(parseRange('bytes=-200', SIZE)).toEqual({ offset: 800, length: 200 })
})

test('suffix larger than the object clamps to the whole object', () => {
  expect(parseRange('bytes=-5000', SIZE)).toEqual({ offset: 0, length: 1000 })
})

test('end past EOF clamps to the last byte', () => {
  expect(parseRange('bytes=0-99999', SIZE)).toEqual({ offset: 0, length: 1000 })
})

test('unsatisfiable ranges are rejected', () => {
  // start == size
  expect(parseRange('bytes=1000-', SIZE)).toBe('unsatisfiable')
  // wholly past EOF
  expect(parseRange('bytes=1500-1600', SIZE)).toBe('unsatisfiable')
  // zero-length suffix
  expect(parseRange('bytes=-0', SIZE)).toBe('unsatisfiable')
})

test('nothing is satisfiable against a zero-byte object', () => {
  // Would otherwise compute `content-range: bytes 0--1/0`.
  expect(parseRange('bytes=-100', 0)).toBe('unsatisfiable')
  expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable')
})

test('an inverted range is invalid, not unsatisfiable', () => {
  // RFC 9110 §14.1.2: last-byte-pos < first-byte-pos is an INVALID
  // range-spec, and an invalid Range header must be ignored (200 with the
  // full body) rather than answered with 416.
  expect(parseRange('bytes=500-100', SIZE)).toBeNull()
})

test('malformed and multi-range headers fall back to the whole object', () => {
  // Serving 200 with the entire body is a valid response to a Range request,
  // so ignoring what we cannot parse is safe.
  expect(parseRange('bytes=abc-def', SIZE)).toBeNull()
  expect(parseRange('bytes=', SIZE)).toBeNull()
  expect(parseRange('bytes=0-1,5-6', SIZE)).toBeNull()
})
