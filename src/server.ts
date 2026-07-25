/**
 * Custom Cloudflare Workers entry point — the whole app in one Worker.
 *
 * TanStack Start's default Worker entry only serves the SSR app. To ALSO ship
 * the sandbox agent's Durable Objects + container in the same deploy we use the
 * documented escape hatch: a custom `src/server.ts` (wired via `wrangler.jsonc`
 * `main`) that re-exports the DO classes and wraps the Start `fetch` handler.
 *
 * Routing order is load-bearing:
 *   1. `proxyToSandbox` — sandbox preview-port traffic, routed by HOSTNAME, so
 *      it gets first refusal before any path-based routing.
 *   2. the agent Worker — `/_bridge` ONLY. The container calls back on that
 *      root, so it is RESERVED for the agent; app routes must go elsewhere.
 *      `/runs` and `/tool-exec` are deliberately NOT routed — see AGENT_PATHS
 *      below before adding either back.
 *   3. TanStack Start — the UI and its `/api/*` server routes.
 *
 * @see https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/
 */
import handler from '@tanstack/react-start/server-entry'
import { proxyToSandbox } from '@cloudflare/sandbox'
import { EventType } from '@tanstack/ai'
import { isTerminalRunStatus } from '@tanstack/ai-sandbox'
import { agent } from './agent'
import type { StreamChunk } from '@tanstack/ai'
import type { RunRecord } from '@tanstack/ai-sandbox'
import type { StartRunInput } from '@tanstack/ai-sandbox-cloudflare/agent'
import type { AppEnv } from './agent'

/** How often the watchdog alarm re-checks in-flight runs. */
const WATCHDOG_MS = 30_000

/**
 * How long a run may go without appending a stream chunk before the watchdog
 * declares the orchestrator dead. The package hardcodes FIVE minutes — tuned
 * for chatty coding agents, not for this studio, where a single silent Bash
 * call (`hyperframes snapshot`, `check`, or a full `render`) routinely runs
 * longer than that with zero stream output. The first "Surprise me" run hit
 * it: the agent finished the whole composition, but the 5-minute watchdog had
 * already marked the run failed — which also revoked the `/_bridge` token, so
 * every remaining host-tool call died with `MCP server "tanstack" is not
 * connected` and the preview URL never reached the user.
 */
const WATCHDOG_STALL_MS = 30 * 60_000

/** Narrow a raw `rec:*` storage value to the run record the watchdog needs. */
function isRunRecord(value: unknown): value is RunRecord {
  return (
    value !== null &&
    typeof value === 'object' &&
    'runId' in value &&
    typeof value.runId === 'string' &&
    'status' in value &&
    typeof value.status === 'string' &&
    'updatedAt' in value &&
    typeof value.updatedAt === 'number'
  )
}

/**
 * The coordinator DO, with the base class's `alarm()` re-implemented to use
 * the longer stall window above. Everything else (scheduling cadence, the
 * fail-then-settle sequence, rescheduling while runs are active) mirrors the
 * base — `failStalledRun` is private there, so the sequence is replicated via
 * the protected `log` + `onRunSettled` seams.
 *
 * Also re-exported so the DO `class_name`s in wrangler.jsonc
 * (`RunCoordinator`, `Sandbox`) resolve in the Worker bundle.
 */
export class RunCoordinator extends agent.Coordinator {
  /**
   * Implemented at runtime by the factory's configured coordinator class; the
   * published constructor type returns the ABSTRACT base, which erases that.
   * `declare` satisfies the abstract-member check without emitting an
   * override that would shadow the real implementation.
   */
  declare protected buildRunStream: (
    input: StartRunInput,
  ) => AsyncIterable<StreamChunk> | Promise<AsyncIterable<StreamChunk>>

  override async alarm(): Promise<void> {
    try {
      const runs = await this.ctx.storage.list({ prefix: 'rec:' })
      const now = Date.now()
      const stalled: Array<string> = []
      let active = false
      for (const value of runs.values()) {
        if (!isRunRecord(value)) continue
        if (isTerminalRunStatus(value.status)) continue
        if (now - value.updatedAt > WATCHDOG_STALL_MS) {
          stalled.push(value.runId)
        } else {
          active = true
        }
      }
      await Promise.all(stalled.map((runId) => this.failStalled(runId)))
      if (active) await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    } catch (error) {
      console.error('[run-coordinator] watchdog alarm failed:', error)
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS)
    }
  }

  /** Mark a stalled run as a terminal error (base's private `failStalledRun`). */
  private async failStalled(runId: string): Promise<void> {
    const message = `run watchdog: no stream progress for ${WATCHDOG_STALL_MS / 60_000} minutes; orchestrator presumed dead`
    try {
      await this.log.append(runId, { type: EventType.RUN_ERROR, message })
    } catch {
      // The run may have finished between the list() and here.
    }
    await this.log.finish(runId, 'error', { message })
    this.onRunSettled(runId)
  }
}

export const Sandbox = agent.Sandbox

/**
 * Root paths owned by the agent; everything else falls through to Start.
 *
 * `/_bridge` is the ONLY one exposed, because it is the only one that has to
 * be reachable over the public internet: the sandbox container calls back to it
 * for the agent's MCP tool calls. It is gated per run by a ~288-bit bearer
 * token, constant-time compared, held in memory only while the run is in flight
 * (`ChatSandboxCoordinator.serveBridge`), so a closed run 404s.
 *
 * Deliberately NOT routed:
 *
 *  • `/runs` — the package's HTTP trigger. `parseCreateRunBody` takes
 *    `threadId` straight from the body and `resolveCoordinator` does
 *    `idFromName(threadId)`, with no authentication at all. Exposing it let
 *    anyone start a run in any thread — and the container a thread is pinned to
 *    holds this app's harness API key. Nothing needs it over HTTP: the
 *    browser goes through `/api/run`, which addresses the coordinator over the
 *    RUN_COORDINATOR binding (required regardless — a Worker fetching its own
 *    hostname is a same-zone self-subrequest, Cloudflare error 1042).
 *
 *  • `/tool-exec` — only ever used by `ContainerSandboxCoordinator`, i.e. the
 *    `colocated` execution mode. This app runs `do-drives`, so it is dead
 *    surface.
 *
 * Removing them beats authenticating them: an endpoint that is not routed
 * cannot be misconfigured later.
 */
const AGENT_PATHS = ['/_bridge']

const ownedByAgent = (pathname: string): boolean =>
  AGENT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

export default {
  async fetch(request, env, ctx) {
    // 1. Preview traffic for a sandbox port, matched on hostname.
    const proxied = await proxyToSandbox(request, env)
    if (proxied) return proxied

    // 2. The agent's own HTTP surface.
    const { pathname } = new URL(request.url)
    if (ownedByAgent(pathname) && agent.worker.fetch) {
      return agent.worker.fetch(request, env, ctx)
    }

    // 3. The TanStack Start app. Its handler takes ONLY the request — the
    //    second argument is an SSR-context option, not the Worker env. Bindings
    //    are read ambiently via the Cloudflare Vite plugin.
    return handler.fetch(request)
  },
} satisfies ExportedHandler<AppEnv>
