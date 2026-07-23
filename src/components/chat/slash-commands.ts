/**
 * The slash commands the composer autocompletes. A message beginning with
 * `/name` reaches the in-sandbox `claude -p` verbatim, which invokes the
 * matching skill — so this list MUST mirror the skills baked into the image
 * (the `hyperframes skills update` layer in the Dockerfile). Descriptions are
 * ours; keep them one line.
 */
export interface SlashCommand {
  name: string
  description: string
}

export const SLASH_COMMANDS: ReadonlyArray<SlashCommand> = [
  {
    name: 'hyperframes',
    description: 'Start any video request — the entry-point workflow',
  },
  {
    name: 'hyperframes-cli',
    description: 'CLI reference: preview, check, render, publish',
  },
  {
    name: 'hyperframes-core',
    description: 'The composition contract: clips, timing, tracks',
  },
  {
    name: 'hyperframes-animation',
    description: 'Motion rules, scene blueprints, the GSAP timeline',
  },
  {
    name: 'hyperframes-creative',
    description: 'Design direction: palettes, typography, narration, beats',
  },
  {
    name: 'hyperframes-keyframes',
    description: 'Seek-safe keyframes, paths, masks, SVG morphs',
  },
  {
    name: 'hyperframes-registry',
    description: 'Install and wire registry blocks and components',
  },
  {
    name: 'media-use',
    description: 'Music, SFX, images, voiceover, captions and media ops',
  },
]
