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

export const agent = createCloudflareSandboxAgent<AppEnv>({
  adapter: () => claudeCodeText(MODEL),

  // App-agnostic transport guidance ("bind wide + allow all hosts", so the
  // quick-tunnel hostname is accepted). The HyperFrames authoring recipe is a
  // host tool rather than a system prompt — see Phase 3.
  systemPrompts: [PREVIEW_GUIDANCE],

  // Host tools, bridged to the in-sandbox agent over MCP at `/_bridge`.
  // `exposePreviewTool` closes over the run's threadId + env, so it must be
  // built per run here rather than hoisted to module scope.
  tools: (input, env) => [exposePreviewTool(input, env)],

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
        // TODO(phase-5): deploy blocker. `POST /runs` is unauthenticated and
        // `threadId` comes straight from the client, and the container is
        // pinned to that threadId — so anyone who guesses or reuses a threadId
        // reaches the same container and workspace, each of which carries this
        // key. CLAUDE.md: "do not put one user's secret in a sandbox another
        // user can reach; the sandbox runs LLM-authored code." Inherited from
        // the upstream example, which is a local demo. Before shipping, put
        // auth in front of /runs and derive threadId from the session rather
        // than trusting the body.
        secrets: createSecrets({
          ANTHROPIC_API_KEY: requireAnthropicKey(env),
        }),
      }),
      // One sandbox per thread, so a follow-up message resumes the same
      // workspace and the compositions the agent already authored.
      lifecycle: { reuse: 'thread' },
    }),
})
