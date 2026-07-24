import { describe, expect, test } from 'bun:test'
import { DEMO_BRIEFS } from './demo-briefs'

describe('DEMO_BRIEFS', () => {
  test('has five briefs with unique ids', () => {
    expect(DEMO_BRIEFS.length).toBe(5)
    const ids = new Set(DEMO_BRIEFS.map((demo) => demo.id))
    expect(ids.size).toBe(DEMO_BRIEFS.length)
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
