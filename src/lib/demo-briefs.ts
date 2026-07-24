/**
 * One-click demo briefs for the empty state. Each brief is FULLY SPECIFIED —
 * duration, format, palette, typography, scene beats, and asset policy — and
 * ends with an explicit no-questions clause, so the agent's interview has
 * nothing left to ask and it goes straight to authoring (the system prompt in
 * `src/agent.ts` makes that contract explicit on the agent side).
 *
 * Pure data, so the invariants (unique ids, the no-questions clause every
 * brief must carry) are unit-testable.
 */

export interface DemoBrief {
  id: string
  /** Card title shown in the empty state. */
  title: string
  /** One-line description under the title. */
  tagline: string
  /** The full user message sent when the card is clicked. */
  brief: string
}

/**
 * Shared tail for every demo brief: the skip-the-interview contract plus the
 * deliverable expectation.
 */
const NO_QUESTIONS =
  'This brief is fully specified — do not ask any questions or offer any choices; start authoring immediately with tasteful defaults for anything unstated, and expose the live preview as soon as it runs. No external assets: pure HTML/CSS/SVG only.'

export const DEMO_BRIEFS: Array<DemoBrief> = [
  {
    id: 'product-teaser',
    title: 'Product teaser',
    tagline: '10s SaaS launch teaser with kinetic type',
    brief: `Make a 10-second, 1920x1080 product teaser for a fictional SaaS called "Nimbus" (tagline: "Ship weather-proof software"). Dark navy background (#0a0f1e), electric blue accent (#3b82f6), white grotesk type. Beats: 0-2s a single bold word "SHIP" scales in; 2-5s three feature words ("Build", "Test", "Deploy") cascade with staggered slides; 5-8s the Nimbus wordmark assembles letter by letter; 8-10s tagline fades up under the wordmark with a soft glow pulse. ${NO_QUESTIONS}`,
  },
  {
    id: 'kinetic-quote',
    title: 'Kinetic quote',
    tagline: '8s typographic quote animation',
    brief: `Make an 8-second, 1920x1080 kinetic typography piece for the quote "Simplicity is the ultimate sophistication" — attributed to Leonardo da Vinci. Warm paper background (#f7f3ec), near-black ink type (#1c1917), one terracotta accent (#c2410c) on the word "Simplicity". Words arrive in rhythmic groups (2-4 words per beat) with mixed scale — oversized keywords, small connective words — ending on a composed full-quote lockup with the attribution in small caps. ${NO_QUESTIONS}`,
  },
  {
    id: 'stat-countup',
    title: 'Data stat hit',
    tagline: '8s animated chart + count-up',
    brief: `Make an 8-second, 1920x1080 data-viz stat hit: headline "Renewables overtake coal", a big animated count-up from 0% to 30% (share of global electricity), and an SVG bar chart of five bars (Coal 26, Gas 22, Hydro 14, Wind 8, Solar 6) that grow in staggered from the baseline with the Wind and Solar bars highlighted. Off-white background, ink-dark type, emerald accent (#059669) for the highlighted bars and the count-up numeral. End on a composed hold with a one-line source caption. ${NO_QUESTIONS}`,
  },
  {
    id: 'logo-sting',
    title: 'Logo sting',
    tagline: '6s geometric logo reveal',
    brief: `Make a 6-second, 1920x1080 logo sting for a fictional studio called "Octant". Build the mark from pure geometry: eight thin SVG arc segments draw on around a circle (stroke-draw animation), snap together into an octagonal badge, then the wordmark "OCTANT" tracks out letter-spaced beneath it. Near-black background (#0c0a09), single amber accent (#f59e0b) for the mark, white type. Finish on a 1-second still hold of the full lockup. ${NO_QUESTIONS}`,
  },
  {
    id: 'countdown-title',
    title: 'Countdown title',
    tagline: '10s cinematic countdown open',
    brief: `Make a 10-second, 1920x1080 cinematic countdown title sequence: oversized numerals 3, 2, 1 (each holding ~1.5s with a scale-and-blur transition and a thin rotating ring behind them), then the title card "ORBIT / A film about small steps" resolves at 6s — title large, subtitle small caps — with a slow starfield of tiny CSS dots drifting behind everything. Deep space black (#020617), off-white type, one cyan accent (#22d3ee) on the ring. ${NO_QUESTIONS}`,
  },
]
