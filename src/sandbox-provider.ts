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
 * Spawn kill: the package's `CloudflareHandle.spawn().kill` is a no-op (see
 * `src/lib/killable-spawn.ts`). We wrap every handle so dispose of a Grok ACP
 * `agent serve` actually frees the port — without that, the next user message
 * fails with a closed WebSocket (issue #30).
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
import {
  killFromPidFile,
  newSpawnPidFile,
  reapLeakedGrokServe,
  wrapCommandWithPidFile,
} from './lib/killable-spawn'
import type { Sandbox } from '@cloudflare/sandbox'
import type {
  ProcessOptions,
  SandboxCreateInput,
  SandboxDestroyInput,
  SandboxHandle,
  SandboxProvider,
  SandboxResumeInput,
  SpawnHandle,
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

/**
 * Layer real `kill()` on the package handle: wrap each spawn command with a
 * PID file, and replace `kill` so ACP `dispose` can stop `grok agent serve`.
 */
function withKillableSpawn(inner: SandboxHandle): SandboxHandle {
  const exec = (command: string) => inner.process.exec(command)

  const handle: SandboxHandle = {
    id: inner.id,
    provider: inner.provider,
    capabilities: inner.capabilities,
    fs: inner.fs,
    git: inner.git,
    ports: inner.ports,
    env: inner.env,
    destroy: () => inner.destroy(),
    process: {
      exec: (command, options) => inner.process.exec(command, options),
      spawn: async (
        command: string,
        options?: ProcessOptions,
      ): Promise<SpawnHandle> => {
        const pidFile = newSpawnPidFile()
        const proc = await inner.process.spawn(
          wrapCommandWithPidFile(command, pidFile),
          options,
        )
        return {
          pid: proc.pid,
          stdout: proc.stdout,
          stderr: proc.stderr,
          stdin: proc.stdin,
          wait: () => proc.wait(),
          kill: async () => {
            await killFromPidFile(exec, pidFile)
          },
        }
      },
    },
  }
  if (inner.workspaceRoot !== undefined) {
    // exactOptionalPropertyTypes: only set when present.
    return { ...handle, workspaceRoot: inner.workspaceRoot }
  }
  return handle
}

async function openHandle(
  sandbox: Sandbox,
  id: string,
  previewHostname: string | undefined,
): Promise<SandboxHandle> {
  // Free a serve left by a previous turn whose kill was a no-op (or never
  // ran). Must run before the new ACP connection binds the port.
  await reapLeakedGrokServe((command) => sandbox.exec(command))
  return withKillableSpawn(
    new CloudflareHandle(id, sandbox, WORKDIR, previewHostname),
  )
}

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
      return openHandle(sandbox, name, previewHostname)
    },
    async resume(input: SandboxResumeInput): Promise<SandboxHandle | null> {
      const sandbox = getSandbox(binding, input.id, SANDBOX_OPTIONS)
      return openHandle(sandbox, input.id, previewHostname)
    },
    async destroy(input: SandboxDestroyInput): Promise<void> {
      await getSandbox(binding, input.id, SANDBOX_OPTIONS).destroy()
    },
  }
}
