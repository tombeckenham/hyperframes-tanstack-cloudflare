/**
 * `hyperframesRecipe` — the canonical authoring recipe, handed to the in-sandbox
 * agent as a bridged host tool rather than a system prompt so it can be pulled
 * per section instead of burning context on every turn.
 *
 * Mirrors the upstream `tanstackStartRecipe` pattern from the reference example.
 *
 * Sourced from the HyperFrames skills and verified against the CLI 0.7.68
 * actually installed in the image. Several commands here deliberately differ
 * from PLAN.md, which described flags that do not exist — see `preview`.
 */
import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'

const scaffold = `
Scaffold with the CLI; never hand-roll the project layout.

    npx hyperframes init <name> --non-interactive --example blank

--example is REQUIRED here. The sandbox is non-TTY, and in non-TTY mode init
refuses to guess. Use --example warm-grain instead of blank if you want a
styled starting point. Add --resolution=portrait (or landscape-4k, square, ...)
to change the frame size, and --tailwind for Tailwind v4 browser-runtime
support.

Then cd into the project directory. Every command below is run from there.
`.trim()

const author = `
COMPOSITION CONTRACT — the rules the renderer actually enforces.

Root element (usually id="root"):
  data-composition-id   REQUIRED, must equal the window.__timelines registry key
  data-width/height     REQUIRED, pixels (1920x1080, 1080x1920, 1080x1080)
  data-duration         Render length in seconds. Read ONCE at compile time —
                        a script or a --variables value CANNOT change it.
  data-fps              Optional hint; render --fps overrides
Root CSS: position: relative, explicit pixel size, overflow: hidden.

data-duration is optional ONLY when duration is inferable: a registered GSAP
timeline, a finite CSS animation, a finite WAAPI animate(), or a Lottie
animation. It is REQUIRED for Three.js and for anything infinite or with no
animation at all. Without a positive duration capture fails outright with
"Composition has zero duration."

Clips:
  class="clip" is REQUIRED on visible timed elements (div, img, ...). Without
  it the runtime shows the element for the WHOLE composition and ignores
  data-start / data-duration. Omit it on <video> (the framework manages
  visibility) and <audio> (nothing visual).

  Clips MUST be DIRECT children of the composition root. A clip nested in a
  wrapper div is never registered — a <video> in a wrapper renders black. To
  wrap or transform a clip, put the wrapper INSIDE the clip.

  id                  REQUIRED, stable
  data-start          REQUIRED, seconds from composition start
  data-duration       REQUIRED for div / img / sub-compositions
  data-track-index    REQUIRED. A temporal lane: two clips on the SAME index
                      must not overlap in time. It is NOT paint order —
                      front/back is CSS z-index.

The visibility window is inclusive at BOTH ends: a clip renders at exactly
t = start + duration, so the final frame holds the resolved end state.

Legacy names to rewrite on sight: data-layer -> data-track-index,
data-end -> data-duration.

DETERMINISM — every frame is a fresh seek; there is no playback. Anything that
depends on having arrived via a previous frame desyncs when the renderer
samples out of order or in parallel.

  - Build the timeline SYNCHRONOUSLY at page init. Exactly one
    gsap.timeline({ paused: true }) per composition, registered on
    window.__timelines["<composition-id>"].
  - Never build timelines inside async / Promise / setTimeout / event handlers.
  - Never call tl.play() for render-critical motion.
  - Never drive visuals from Date.now(), performance.now(), unseeded
    Math.random(), render-time fetches, or hover/scroll/pointer state.
  - Never use repeat: -1. Compute a finite count:
        repeat: Math.max(0, Math.floor(duration / cycleDuration) - 1)
    floor, NOT ceil — ceil overshoots data-duration and trips the lint rule
    gsap_repeat_ceil_overshoot.
  - Never animate the same property of the same element from two timelines at
    once; GSAP's overwrite order can flip between renders.

  Animate only: opacity, x, y, scale, rotation, color, backgroundColor,
  borderRadius, transforms. Never tween display or visibility. Never use
  width/height/top/left for motion — use GSAP transform aliases. Never target a
  .clip element; HyperFrames owns its lifecycle.

LAYOUT — build the visible end state in static HTML/CSS first, then animate to
it.
  - Scene containers: width/height 100%, box-sizing: border-box.
  - No <br> in body text (forced breaks ignore rendered font width and cause
    overlap). Exception: short display titles, one word per line.
  - Transformed elements must be block-level and sized — transform is a no-op
    on an inline <span>, and scaling an auto-width element shows nothing.
  - Never derive positions from getBoundingClientRect() at tween time; compute
    coordinates once at setup.

If you reach for setTimeout, requestAnimationFrame or addEventListener to drive
a visual, rebuild it as a tween on the timeline instead.
`.trim()

const preview = `
Check, then preview. Do NOT render until the user has approved the preview.

    npx hyperframes lint          # after the first HTML pass
    npx hyperframes check         # the real gate — it RERUNS lint itself

Do not run a standalone lint immediately before check; it is redundant.
validate, inspect and layout are DEPRECATED aliases for check — never use them.
Add --strict to make warnings fail too.

Start the studio:

    npx hyperframes preview --port 3002 --no-open

  - There is NO --host flag. The server binds 127.0.0.1 unless
    HYPERFRAMES_PREVIEW_HOST=0.0.0.0, which this image already sets — do not
    unset it or nothing outside the container can reach the preview.
  - NEVER bind port 3000: it is the sandbox control plane.
  - --no-open matters; --open defaults to true and tries to spawn a browser.
  - The server SCANS FORWARD from --port for a free port, so it may not land on
    3002. Confirm the real port by probing /__hyperframes_config before
    exposing it.

Then call the exposePreview tool with the port you confirmed, e.g.
{ "port": 3002 }. That opens a public tunnel and returns the URL to show the
user. Starting the tunnel is a host-side call — you cannot do it from bash.

When sub-compositions are mounted, snapshot the midpoints and actually look at
them:

    npx hyperframes snapshot --at 1.5,4,7.25
`.trim()

const render = `
Render ONLY after the user approves the preview.

    npx hyperframes render --quality draft            # fast iteration
    npx hyperframes render --quality high -o out.mp4  # delivery

Then verify, rather than assuming success:

    test -s out.mp4
    ffprobe -v error -show_format out.mp4

Useful flags: --format mp4|webm|mov|gif|png-sequence (mov/webm carry
transparency), --fps, --resolution, --variables '{"title":"X"}', --strict.

In this container prefer -w 1: each render worker is a separate Chrome process
at roughly 256 MB, and determinism beats throughput here. --low-memory-mode
engages automatically under 8 GB.

To publish, call the host tools rather than the CLI's own publish (which
uploads to hyperframes.dev, not this app's storage):
  - publishComposition — bundles the project to a single self-contained HTML
    file and stores it, returning a durable URL that outlives this container.
  - publishRender — uploads a rendered MP4 and returns its URL.
  - listArtifacts — lists what this thread has already published.

Remember the container disk is ephemeral: anything not published is lost.
`.trim()

const RECIPE = { scaffold, author, preview, render } as const

const SECTIONS = ['scaffold', 'author', 'preview', 'render', 'all'] as const

export const hyperframesRecipe = toolDefinition({
  name: 'hyperframesRecipe',
  description:
    'The canonical recipe for authoring, previewing and rendering a HyperFrames composition in this sandbox. Call this BEFORE scaffolding, and re-read a section before the step it covers. It reflects the CLI version actually installed here, so prefer it over prior knowledge.',
  inputSchema: z.object({
    section: z
      .enum(SECTIONS)
      .describe('Which part of the recipe you need (use "all" first).'),
  }),
}).server(({ section }) =>
  section === 'all' ? RECIPE : { [section]: RECIPE[section] },
)
