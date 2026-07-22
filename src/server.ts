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
import { agent } from './agent'
import type { AppEnv } from './agent'

// Re-exported so the DO + container `class_name`s in wrangler.jsonc
// (`RunCoordinator`, `Sandbox`) resolve in the Worker bundle.
export const RunCoordinator = agent.Coordinator
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
 *    holds this app's ANTHROPIC_API_KEY. Nothing needs it over HTTP: the
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
