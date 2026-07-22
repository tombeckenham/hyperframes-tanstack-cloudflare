/**
 * `namedCloudflareSandbox` — the package's `cloudflareSandbox()` provider, but
 * pinned to a KNOWN container Durable Object name instead of a random UUID.
 *
 * Why this exists: host tools have to address the *same* container the agent is
 * working in. `exposePreview` opens a quick tunnel via
 * `getSandbox(binding, threadId).tunnels.get(port)`, and the render publisher
 * reads files back out of the workspace. The package's default provider names
 * the container `input.id ?? crypto.randomUUID()` — a name the host never sees,
 * so neither tool could find it.
 *
 * Pinning to the run's `threadId` is also strictly better for
 * `lifecycle: { reuse: 'thread' }`: the container stays addressable across
 * Durable Object eviction, not merely within one live instance.
 *
 * Note the import of `CLOUDFLARE_CAPS` / `CloudflareHandle` from the package
 * ROOT entry, not `/agent`. The `/agent` entry imports `cloudflare:workers` and
 * is Workers-only; the root entry is node-safe. Keep it that way.
 */
import { getSandbox } from '@cloudflare/sandbox'
import {
  CLOUDFLARE_CAPS,
  CloudflareHandle,
} from '@tanstack/ai-sandbox-cloudflare'
import type { Sandbox } from '@cloudflare/sandbox'
import type {
  SandboxCreateInput,
  SandboxDestroyInput,
  SandboxHandle,
  SandboxProvider,
  SandboxResumeInput,
} from '@tanstack/ai-sandbox'

const WORKDIR = '/workspace'

/**
 * `sandbox.tunnels` (the quick-tunnel preview URLs) exists only on the RPC
 * transport, and the transport must be IDENTICAL for every `getSandbox()` of a
 * given id — a mismatch disconnects the run's active client. So create, resume
 * and destroy all pass it, and `wrangler.jsonc` sets `SANDBOX_TRANSPORT: "rpc"`
 * to match on the server side.
 */
const SANDBOX_OPTIONS = { transport: 'rpc' } as const

export function namedCloudflareSandbox(
  binding: DurableObjectNamespace<Sandbox>,
  name: string,
  previewHostname?: string,
): SandboxProvider {
  return {
    name: 'cloudflare-named',
    capabilities: () => CLOUDFLARE_CAPS,
    async create(input: SandboxCreateInput): Promise<SandboxHandle> {
      const sandbox = getSandbox(binding, name, SANDBOX_OPTIONS)
      if (input.env && Object.keys(input.env).length > 0) {
        await sandbox.setEnvVars(input.env)
      }
      await sandbox.mkdir(WORKDIR, { recursive: true })
      return new CloudflareHandle(name, sandbox, WORKDIR, previewHostname)
    },
    resume: (input: SandboxResumeInput): Promise<SandboxHandle | null> =>
      Promise.resolve(
        new CloudflareHandle(
          input.id,
          getSandbox(binding, input.id, SANDBOX_OPTIONS),
          WORKDIR,
          previewHostname,
        ),
      ),
    async destroy(input: SandboxDestroyInput): Promise<void> {
      await getSandbox(binding, input.id, SANDBOX_OPTIONS).destroy()
    },
  }
}
