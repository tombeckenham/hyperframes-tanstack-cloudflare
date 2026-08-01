import { expect, test } from 'bun:test'
import {
  killFromPidFile,
  newSpawnPidFile,
  reapLeakedGrokServe,
  shQuote,
  wrapCommandWithPidFile,
} from './killable-spawn'

test('shQuote wraps and escapes single quotes', () => {
  expect(shQuote('plain')).toBe(`'plain'`)
  expect(shQuote(`it's`)).toBe(`'it'\\''s'`)
})

test('wrapCommandWithPidFile records $$ then execs the original command', () => {
  const wrapped = wrapCommandWithPidFile(
    `grok agent -m 'grok-4.5' serve --bind '0.0.0.0:2419'`,
    '/tmp/hf-spawn-test.pid',
  )
  // Outer sh -c script: write pid, then exec the original (with quotes intact).
  expect(wrapped.startsWith(`sh -c '`)).toBe(true)
  expect(wrapped).toContain('echo $$ > /tmp/hf-spawn-test.pid')
  expect(wrapped).toContain('exec grok agent -m')
  expect(wrapped).toContain('serve --bind')
  // Original single-quoted tokens survive the outer shQuote escape.
  expect(wrapped).toContain(`'\\''grok-4.5'\\''`)
})

test('newSpawnPidFile is under /tmp with a uuid-ish suffix', () => {
  const a = newSpawnPidFile()
  const b = newSpawnPidFile()
  expect(a.startsWith('/tmp/hf-spawn-')).toBe(true)
  expect(a.endsWith('.pid')).toBe(true)
  expect(a).not.toBe(b)
})

test('killFromPidFile runs TERM then KILL against the recorded pid', async () => {
  const commands: Array<string> = []
  await killFromPidFile(async (command) => {
    commands.push(command)
  }, '/tmp/hf-spawn-abc.pid')
  expect(commands).toHaveLength(1)
  const script = commands[0] ?? ''
  expect(script).toContain(`cat '/tmp/hf-spawn-abc.pid'`)
  expect(script).toContain('kill -TERM')
  expect(script).toContain('kill -KILL')
  expect(script).toContain(`rm -f '/tmp/hf-spawn-abc.pid'`)
})

test('reapLeakedGrokServe issues a best-effort pkill for leftover serves', async () => {
  const commands: Array<string> = []
  await reapLeakedGrokServe(async (command) => {
    commands.push(command)
  })
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatch(/pkill/)
  // `[g]rok` so pkill does not match its own argv.
  expect(commands[0]).toMatch(/\[g\]rok/)
})
