/**
 * `exposePreview`, hardened. Replaces the package's version, which is a bare
 * `sandbox.tunnels.get(port)` — and `tunnels.get` is idempotent per port: it
 * returns the CACHED tunnel record from DO storage without checking that the
 * cloudflared process (or the server behind it) still exists. First live run
 * hit exactly that: the preview server died, the agent restarted it, and
 * exposePreview handed back the same dead URL — a 502 at the trycloudflare
 * edge.
 *
 * This version establishes three facts before returning a URL:
 *   1. Something is listening on the port INSIDE the container (curl probe).
 *   2. The tunnel URL answers at the edge with a non-5xx.
 *   3. If (2) fails, the tunnel is destroyed and re-established once, with a
 *      short retry window for fresh-tunnel DNS/edge propagation.
 */
import { toolDefinition } from '@tanstack/ai'
import { getSandbox } from '@cloudflare/sandbox'
import { z } from 'zod'
import type { Sandbox } from '@cloudflare/sandbox'
import type { StartRunInput } from '@tanstack/ai-sandbox-cloudflare/agent'

/** Must match every other getSandbox() for this id — see sandbox-provider.ts. */
const SANDBOX_OPTIONS = { transport: 'rpc' } as const

export interface PreviewToolEnv {
  Sandbox: DurableObjectNamespace<Sandbox>
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A tunnel origin is healthy when the edge relays ANY origin response —
 * including 404s (the origin answered). 502/530-class means the edge could
 * not reach the origin: exactly the stale-tunnel signature.
 */
async function edgeAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    return response.status < 500
  } catch {
    return false
  }
}

/** Retry the edge probe briefly — fresh tunnels take a moment to propagate. */
async function edgeAnswersEventually(url: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    // oxlint-disable-next-line no-await-in-loop
    if (await edgeAnswers(url)) return true
    // oxlint-disable-next-line no-await-in-loop
    await wait(2000)
  }
  return edgeAnswers(url)
}

export function exposePreviewTool(input: StartRunInput, env: PreviewToolEnv) {
  return toolDefinition({
    name: 'exposePreview',
    description:
      'Expose a port a dev server is listening on inside the sandbox and return a public preview URL (a Cloudflare quick tunnel). Call this AFTER the server is up — and call it AGAIN after restarting the server: it verifies the tunnel end to end and re-establishes it if stale. The dev server must bind 0.0.0.0 and allow all hosts.',
    inputSchema: z.object({
      port: z
        .number()
        .int()
        .min(1024)
        .max(65535)
        .describe(
          'The port the dev server is listening on (never 3000 — sandbox control plane).',
        ),
    }),
  }).server(async ({ port }) => {
    if (port === 3000) {
      return {
        ok: false as const,
        error: 'port 3000 is the sandbox control plane and cannot be exposed',
      }
    }
    const sandbox = getSandbox(env.Sandbox, input.threadId, SANDBOX_OPTIONS)

    // 1. Is anything listening in-container? Catches the wrong-port case —
    // the preview server SCANS FORWARD from its --port for a free one.
    const probe = await sandbox.exec(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/`,
    )
    const originStatus = probe.stdout.trim()
    if (!probe.success || originStatus === '000' || originStatus === '') {
      return {
        ok: false as const,
        error: `nothing answered on port ${port} inside the sandbox — confirm the real port with \`npx hyperframes preview --status\` (the server scans forward from --port) and that it is still running`,
      }
    }

    // 2. Cached-or-fresh tunnel, verified at the edge.
    let tunnel = await sandbox.tunnels.get(port)
    if (await edgeAnswersEventually(tunnel.url)) {
      return { ok: true as const, url: tunnel.url }
    }

    // 3. Stale record (server or cloudflared died since it was minted):
    // tear it down and mint a fresh one.
    await sandbox.tunnels.destroy(port)
    tunnel = await sandbox.tunnels.get(port)
    if (await edgeAnswersEventually(tunnel.url)) {
      return {
        ok: true as const,
        url: tunnel.url,
        note: 'The previous tunnel had gone stale and was re-established — share this NEW URL; the old one is dead.',
      }
    }

    return {
      ok: false as const,
      error: `the tunnel could not reach port ${port} even after re-establishing it — the server may be crashing; check \`npx hyperframes preview --status\` and the server logs`,
    }
  })
}
