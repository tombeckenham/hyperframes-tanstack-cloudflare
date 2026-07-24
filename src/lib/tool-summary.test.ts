import { expect, test } from 'bun:test'
import { toolCallSummary } from './tool-summary'

test('Bash prefers the description, falls back to the command', () => {
  expect(
    toolCallSummary(
      'Bash',
      JSON.stringify({
        command: 'npx hyperframes check',
        description: 'Validate the composition',
      }),
    ),
  ).toBe('Validate the composition')
  expect(
    toolCallSummary(
      'Bash',
      JSON.stringify({ command: 'npx hyperframes check' }),
    ),
  ).toBe('npx hyperframes check')
})

test('multi-line commands collapse to one line', () => {
  expect(
    toolCallSummary(
      'Bash',
      JSON.stringify({
        command: 'cd /workspace/studio &&\n  npx hyperframes lint',
      }),
    ),
  ).toBe('cd /workspace/studio && npx hyperframes lint')
})

test('file tools show a workspace-relative path', () => {
  expect(
    toolCallSummary(
      'Read',
      JSON.stringify({ file_path: '/workspace/studio/index.html' }),
    ),
  ).toBe('studio/index.html')
  expect(
    toolCallSummary('Edit', JSON.stringify({ file_path: '/etc/hosts' })),
  ).toBe('/etc/hosts')
})

test('Skill shows the slash form with args', () => {
  expect(
    toolCallSummary('Skill', JSON.stringify({ skill: 'hyperframes' })),
  ).toBe('/hyperframes')
  expect(
    toolCallSummary(
      'Skill',
      JSON.stringify({ skill: 'motion-graphics', args: 'logo sting' }),
    ),
  ).toBe('/motion-graphics logo sting')
})

test('exposePreview shows the port through any MCP prefix', () => {
  expect(
    toolCallSummary(
      'mcp__tanstack__exposePreview',
      JSON.stringify({ port: 3002 }),
    ),
  ).toBe('port 3002')
})

test('unknown tools fall back to the first string argument', () => {
  expect(
    toolCallSummary(
      'SomeTool',
      JSON.stringify({ flag: true, target: 'intro scene' }),
    ),
  ).toBe('intro scene')
  expect(toolCallSummary('SomeTool', JSON.stringify({ flag: true }))).toBe(null)
})

test('streaming (partial) arguments produce no summary', () => {
  expect(toolCallSummary('Bash', '{"command": "npx hyper')).toBe(null)
  expect(toolCallSummary('Bash', '')).toBe(null)
})
