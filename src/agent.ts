/**
 * The HyperFrames studio agent: one `createCloudflareSandboxAgent` call that
 * returns the run-coordinator Durable Object, the Sandbox container DO, and the
 * Worker fetch handler wired together.
 *
 * Execution model is `do-drives` (the default): the coordinator DO runs
 * `chat()` and the container only runs the `claude` CLI. The `colocated` mode
 * would need a second bundled build target inside the image.
 *
 * One harness — Claude Code. The upstream example is a three-harness demo; this
 * app is a HyperFrames studio, not a harness comparison. The topology is
 * adapter-agnostic, so Codex/Grok could be added later without touching the
 * wiring below.
 */
import {
  PREVIEW_GUIDANCE,
  createCloudflareSandboxAgent,
  exposePreviewTool,
} from '@tanstack/ai-sandbox-cloudflare/agent'
import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
} from '@tanstack/ai-sandbox'
import { claudeCodeText } from '@tanstack/ai-claude-code'
import { namedCloudflareSandbox } from './sandbox-provider'
import { hyperframesRecipe } from './tools/recipe'
import {
  listArtifactsTool,
  publishCompositionTool,
  publishRenderTool,
} from './tools/publish'
import type { SandboxAgentEnv } from '@tanstack/ai-sandbox-cloudflare/agent'

/**
 * The env shape the agent expects: the package's harness-agnostic
 * `SandboxAgentEnv` (which contributes `RUN_COORDINATOR`, `Sandbox`,
 * `PUBLIC_HOSTNAME?` and `PREVIEW_HOSTNAME?`) plus this app's own bindings.
 */
export interface AppEnv extends SandboxAgentEnv {
  /** Secret. `wrangler secret put ANTHROPIC_API_KEY`; `.dev.vars` locally. */
  ANTHROPIC_API_KEY?: string
  /** Rendered MP4s and bundled composition HTML. Used from Phase 3 on. */
  RENDERS: R2Bucket
}

/**
 * The model the in-sandbox `claude` CLI runs. The bare alias is deliberate —
 * the CLI resolves it to the current Sonnet, so the studio follows model
 * releases without a redeploy.
 */
const MODEL = 'sonnet'

/**
 * Fail loudly and early when the key is missing. `createSecrets` requires
 * `Record<string, string>`, so this guard is what narrows `string | undefined`
 * — but the real reason it exists is that without it a keyless run starts and
 * then dies deep inside the CLI with an opaque error.
 */
function requireAnthropicKey(env: AppEnv): string {
  const key = env.ANTHROPIC_API_KEY
  if (key === undefined || key === '') {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .dev.vars for local dev, or run `wrangler secret put ANTHROPIC_API_KEY` for a deployed Worker.',
    )
  }
  return key
}

/**
 * The agent's role, and the pointer to everything else. Deliberately SHORT:
 * the full authoring recipe stays behind the `hyperframesRecipe` tool so it is
 * pulled per section instead of burning context on every turn — but without
 * this pointer the agent has no idea it IS a HyperFrames studio. The first
 * live run proved it: with only transport guidance in the prompt, the agent
 * ran the CLI fine when told to, and volunteered "I don't have independent
 * knowledge of what hyperframes is" — so a "make me a video" request reads as
 * something it lacks access to.
 */
const STUDIO_ROLE = `You are the authoring agent of a HyperFrames video studio. The user chats with you to create HTML video compositions, previewed live and rendered to MP4.

This sandbox has the complete HyperFrames toolchain preinstalled: the \`hyperframes\` CLI, Node, Chromium, ffmpeg, and the HyperFrames agent skills (in ~/.claude/skills — /hyperframes is the entry-point workflow for any video request). You author compositions here yourself — never claim you lack access to HyperFrames.

YOUR VERY FIRST ACTION in a new thread — before replying, before asking clarifying questions, before anything else — is to load the /hyperframes skill (via your Skill tool). It is the mandatory entry point: it routes the request, and it decides what to ask the user. "First authoring step" is NOT the trigger; the first user message is. Then call the hyperframesRecipe tool with section "all" for the rules SPECIFIC TO THIS SANDBOX — ports, preview, publishing. Where skill and recipe disagree, the recipe wins: it reflects the CLI version installed HERE.

Work under /workspace. Preview with the recipe's preview steps plus the exposePreview tool; publish results with publishComposition and publishRender — the container disk is ephemeral, so unpublished work is lost.`

export const agent = createCloudflareSandboxAgent<AppEnv>({
  adapter: () => claudeCodeText(MODEL),

  // Role first, then the app-agnostic transport guidance ("bind wide + allow
  // all hosts", so the quick-tunnel hostname is accepted).
  systemPrompts: [STUDIO_ROLE, PREVIEW_GUIDANCE],

  // Host tools, bridged to the in-sandbox agent over MCP at `/_bridge`. All but
  // the recipe close over the run's threadId + env, so they are built per run
  // here rather than hoisted to module scope.
  //
  // This is the lane for everything the sandbox must not do itself: minting
  // preview URLs, holding the R2 binding, and deciding the public key space.
  tools: (input, env) => [
    hyperframesRecipe,
    exposePreviewTool(input, env),
    publishCompositionTool(input, env),
    publishRenderTool(input, env),
    listArtifactsTool(input, env),
  ],

  sandbox: (input, env) =>
    defineSandbox({
      id: 'hyperframes-studio',
      // Pinned to threadId so host tools address the SAME container the agent
      // works in. No preview hostname is passed: previews go through a
      // Cloudflare quick tunnel, not `exposePort`, so there is nothing to
      // resolve — and `resolvePreviewHost` would throw on a *.workers.dev
      // deploy if we called it eagerly here.
      provider: namedCloudflareSandbox(env.Sandbox, input.threadId),
      workspace: defineWorkspace({
        // Nothing to clone — the container image already ships the `claude`
        // CLI and the whole HyperFrames toolchain.
        source: { type: 'none' },
        // Every container carries this key, and the container is pinned to
        // `threadId` — so whoever can NAME a threadId can reach the workspace
        // holding it. CLAUDE.md: "do not put one user's secret in a sandbox
        // another user can reach; the sandbox runs LLM-authored code."
        //
        // Two things keep that closed, and both must stay true:
        //   1. `/runs` is not routed publicly (src/server.ts). The package's
        //      trigger takes threadId from the request body with no auth.
        //   2. `threadId` is derived, never client-supplied — see
        //      src/lib/session.ts. `/api/run` MUST use `deriveThreadId`; a raw
        //      value from the request body reopens the hole.
        secrets: createSecrets({
          ANTHROPIC_API_KEY: requireAnthropicKey(env),
        }),
      }),
      // One sandbox per thread, so a follow-up message resumes the same
      // workspace and the compositions the agent already authored.
      lifecycle: { reuse: 'thread' },
    }),
})
