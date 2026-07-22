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
 *   2. the agent Worker — `/runs`, `/_bridge`, `/tool-exec`. The container
 *      calls back on the root-level `/_bridge` and `/tool-exec` paths, so those
 *      roots are RESERVED for the agent; app routes must go elsewhere.
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

/** Root paths owned by the agent; everything else falls through to Start. */
const AGENT_PATHS = ['/runs', '/_bridge', '/tool-exec']

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
