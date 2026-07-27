import { describe, expect, test } from 'bun:test'
import { DEMO_BRIEFS } from './demo-briefs'

describe('DEMO_BRIEFS', () => {
  test('has six briefs with unique ids', () => {
    expect(DEMO_BRIEFS.length).toBe(6)
    const ids = new Set(DEMO_BRIEFS.map((demo) => demo.id))
    expect(ids.size).toBe(DEMO_BRIEFS.length)
  })

  test('the dolphin Imagine brief leads and is grok-gated', () => {
    const first = DEMO_BRIEFS[0]
    expect(first?.id).toBe('dolphin-imagine')
    expect(first?.harness).toBe('grok')
    expect(first?.brief).toContain('XAI_API_KEY')
    // The generated image must land where the player media proxy serves from.
    expect(first?.brief).toContain('assets/dolphin.jpg')
  })

  test('only harness-gated briefs may skip the pure-HTML asset policy', () => {
    for (const demo of DEMO_BRIEFS) {
      if (demo.harness === undefined) {
        expect(demo.brief).toContain('No external assets')
      }
    }
  })

  test('every brief carries the no-questions clause the agent keys on', () => {
    for (const demo of DEMO_BRIEFS) {
      expect(demo.brief).toContain('do not ask any questions')
    }
  })

  test('every brief specifies duration and resolution', () => {
    for (const demo of DEMO_BRIEFS) {
      expect(demo.brief).toMatch(/\d+-second/)
      expect(demo.brief).toContain('1920x1080')
    }
  })

  test('briefs fit the /api/run message path (non-empty, sane length)', () => {
    for (const demo of DEMO_BRIEFS) {
      expect(demo.title.length).toBeGreaterThan(0)
      expect(demo.tagline.length).toBeGreaterThan(0)
      expect(demo.brief.length).toBeGreaterThan(100)
      expect(demo.brief.length).toBeLessThan(2000)
    }
  })
})
