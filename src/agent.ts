/**
 * The HyperFrames studio agent: one `createCloudflareSandboxAgent` call that
 * returns the run-coordinator Durable Object, the Sandbox container DO, and the
 * Worker fetch handler wired together.
 *
 * Execution model is `do-drives` (the default): the coordinator DO runs
 * `chat()` and the container only runs the selected coding-agent CLI. The
 * `colocated` mode would need a second bundled build target inside the image.
 *
 * Two harnesses — Grok Build and Claude Code. The image ships both CLIs;
 * selection is host-side from Worker secrets: `XAI_API_KEY` → Grok (wins if
 * both are set), else `ANTHROPIC_API_KEY` → Claude. See `src/lib/harness.ts`.
 * Topology is adapter-agnostic: only the adapter and the injected API key
 * change per run.
 */
import {
  PREVIEW_GUIDANCE,
  createCloudflareSandboxAgent,
} from '@tanstack/ai-sandbox-cloudflare/agent'
import {
  createSecrets,
  defineSandbox,
  defineWorkspace,
} from '@tanstack/ai-sandbox'
import { claudeCodeText } from '@tanstack/ai-claude-code'
import { grokBuildText } from '@tanstack/ai-grok-build'
import { namedCloudflareSandbox } from './sandbox-provider'
import { harnessSecrets, resolveHarness } from './lib/harness'
import { hyperframesRecipe } from './tools/recipe'
import { askUserTool } from './tools/ask-user'
// Ours, not the package's: verifies the tunnel end to end and re-establishes
// stale ones — see src/tools/preview.ts for the failure mode this closes.
import { exposePreviewTool } from './tools/preview'
import {
  listArtifactsTool,
  publishCompositionTool,
  publishRenderTool,
} from './tools/publish'
import type { SandboxAgentEnv } from '@tanstack/ai-sandbox-cloudflare/agent'
import type { HarnessName } from './lib/harness'

/**
 * The env shape the agent expects: the package's harness-agnostic
 * `SandboxAgentEnv` (which contributes `RUN_COORDINATOR`, `Sandbox`,
 * `PUBLIC_HOSTNAME?` and `PREVIEW_HOSTNAME?`) plus this app's own bindings.
 * Keys are optional on the type; {@link resolveHarness} fails clearly at run
 * time if neither is set.
 */
export interface AppEnv extends SandboxAgentEnv {
  /** Secret. Claude Code harness. Used when `XAI_API_KEY` is unset. */
  ANTHROPIC_API_KEY?: string
  /** Secret. Grok Build harness. Wins over `ANTHROPIC_API_KEY` when both set. */
  XAI_API_KEY?: string
  /** Rendered MP4s and bundled composition HTML. */
  RENDERS: R2Bucket
}

/** Claude Code model alias — the CLI resolves it to the current Sonnet. */
const CLAUDE_MODEL = 'sonnet'

/** Default Grok Build model (matches the TanStack sandbox-cloudflare example). */
const GROK_MODEL = 'composer-2.5'

function buildAdapter(harness: HarnessName) {
  if (harness === 'grok') {
    return grokBuildText(GROK_MODEL, {
      protocol: 'acp',
      transport: 'auto',
    })
  }
  return claudeCodeText(CLAUDE_MODEL)
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

EVERY user message is a video brief — there is no other kind of message here. A bare topic or question ("Explain relativity", "how do jet engines work") is a brief for an EXPLAINER VIDEO about that topic, not a knowledge question: never answer it in prose. When the /hyperframes workflow's routing offers a "not a video request" exit, that exit does not apply in this studio — pick the closest video route (usually the explainer) instead, and use askUser to settle direction (length, tone, style), never to ask whether a video is wanted at all.

This sandbox has the complete HyperFrames toolchain preinstalled: the \`hyperframes\` CLI, Node, Chromium, ffmpeg, and the HyperFrames agent skills (under ~/.claude/skills and ~/.grok/skills — /hyperframes is the entry-point workflow for any video request). You author compositions here yourself — never claim you lack access to HyperFrames.

YOUR VERY FIRST ACTION in a new thread — before replying, before asking clarifying questions, before anything else — is to load the /hyperframes skill (via your Skill tool, or by reading the skill files if that is how you load skills). It is the mandatory entry point: it routes the request, and it decides what to ask the user. "First authoring step" is NOT the trigger; the first user message is. Then call the hyperframesRecipe tool with section "all" for the rules SPECIFIC TO THIS SANDBOX — ports, preview, publishing. Where skill and recipe disagree, the recipe wins: it reflects the CLI version installed HERE.

When the user must choose — interview questions, style directions, approval to render — ask with the askUser tool (one question per turn, then end your turn and wait), never with a prose list of options.

EXCEPTION — fully specified briefs: when a brief already states duration, format, palette, and scene beats (the studio's one-click demo briefs do, and they say so explicitly), skip the interview and every askUser call entirely. Do not confirm, do not offer alternatives; choose tasteful defaults for anything unstated, author immediately, and make your first user-visible milestone the live preview URL.

Author in the ready-made project at /workspace/studio — it ships in the image and the studio UI usually has its live preview on screen already, so your edits hot-reload in front of the user (the recipe's scaffold section has the details; do not init a new project unless it says to). Preview with the recipe's preview steps plus the exposePreview tool; publish results with publishComposition and publishRender — the container disk is ephemeral, so unpublished work is lost.`

export const agent = createCloudflareSandboxAgent<AppEnv>({
  // Resolved per run from Worker secrets (XAI wins if both are set).
  adapter: (_input, env) => buildAdapter(resolveHarness(env)),

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
    askUserTool(),
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
        // Nothing to clone — the container image already ships both harness
        // CLIs and the whole HyperFrames toolchain.
        source: { type: 'none' },
        // Every container carries the selected harness key, and the container
        // is pinned to `threadId` — so whoever can NAME a threadId can reach
        // the workspace holding it. CLAUDE.md: "do not put one user's secret
        // in a sandbox another user can reach; the sandbox runs LLM-authored
        // code."
        //
        // Two things keep that closed, and both must stay true:
        //   1. `/runs` is not routed publicly (src/server.ts). The package's
        //      trigger takes threadId from the request body with no auth.
        //   2. `threadId` is derived, never client-supplied — see
        //      src/lib/session.ts. `/api/run` MUST use `deriveThreadId`; a raw
        //      value from the request body reopens the hole.
        //
        // Only the active harness key is injected (never both).
        secrets: createSecrets(harnessSecrets(env)),
      }),
      // One sandbox per thread, so a follow-up message resumes the same
      // workspace and the compositions the agent already authored.
      lifecycle: { reuse: 'thread' },
    }),
})
