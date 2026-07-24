/**
 * `exposePreview`, hardened. Replaces the package's version, which is a bare
 * `sandbox.tunnels.get(port)` — and `tunnels.get` is idempotent per port: it
 * returns the CACHED tunnel record from DO storage without checking that the
 * cloudflared process (or the server behind it) still exists. First live run
 * hit exactly that: the preview server died, the agent restarted it, and
 * exposePreview handed back the same dead URL — a 502 at the trycloudflare
 * edge.
 *
 * The verification itself (origin probe → edge probe → destroy-and-re-mint
 * once) lives in src/lib/preview-tunnel.ts, shared with the studio's
 * `/api/preview` ensure endpoint; this file owns the tool surface and the
 * agent-facing error messages.
 */
import { toolDefinition } from '@tanstack/ai'
import { getSandbox } from '@cloudflare/sandbox'
import { z } from 'zod'
import { ensureVerifiedTunnel, originListening } from '../lib/preview-tunnel'
import type { Sandbox } from '@cloudflare/sandbox'
import type { StartRunInput } from '@tanstack/ai-sandbox-cloudflare/agent'

/** Must match every other getSandbox() for this id — see sandbox-provider.ts. */
const SANDBOX_OPTIONS = { transport: 'rpc' } as const

export interface PreviewToolEnv {
  Sandbox: DurableObjectNamespace<Sandbox>
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

    if (!(await originListening(sandbox, port))) {
      return {
        ok: false as const,
        error: `nothing answered on port ${port} inside the sandbox — confirm the real port with \`npx hyperframes preview --status\` (the server scans forward from --port) and that it is still running`,
      }
    }

    const tunnel = await ensureVerifiedTunnel(sandbox, port)
    if (!tunnel.ok) {
      return {
        ok: false as const,
        error: `${tunnel.error}; check \`npx hyperframes preview --status\` and the server logs`,
      }
    }
    if (tunnel.reestablished) {
      return {
        ok: true as const,
        url: tunnel.url,
        note: 'The previous tunnel had gone stale and was re-established — share this NEW URL; the old one is dead.',
      }
    }
    return { ok: true as const, url: tunnel.url }
  })
}
