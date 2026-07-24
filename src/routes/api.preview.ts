/**
 * `POST /api/preview` — the preview pane's two verbs (contract in
 * src/lib/preview-body.ts):
 *
 *   { action: 'ensure', threadKey }  →  { ok, url, port, project } | { ok, error }
 *   { action: 'probe',  url }        →  { healthy }
 *
 * `ensure` is what makes the Preview tab live from the first page load, before
 * the agent has done anything: it boots (or reuses) the thread's container,
 * restores the baked starter project if the workspace lost it, starts
 * `hyperframes preview` when nothing is serving, and returns a tunnel URL
 * verified end to end (src/lib/preview-tunnel.ts). It is also the "Resume"
 * button's handler after the sandbox goes to sleep. Expensive by design — a
 * cold container boot can take tens of seconds — so the UI calls it once per
 * thread and on explicit resume only.
 *
 * `probe` is the cheap health check the UI polls: one Worker-side fetch of the
 * tunnel URL. A slept container's cloudflared is gone, so the edge answers
 * 5xx (or the hostname stops resolving) and death is detected WITHOUT waking
 * the container — polling `ensure` instead would keep it billed and awake
 * forever. The URL is allowlisted to `*.trycloudflare.com` at the schema so
 * this cannot be used as an open request proxy.
 *
 * Thread identity follows the `/api/run` contract: `threadId` is derived from
 * the session cookie + threadKey (never client-supplied), and `resolveSession`'s
 * cookie is attached when minted. The shell commands below are constant
 * strings — nothing client-supplied is ever interpolated; the scanned port is
 * parsed from container output as an integer before reuse.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getSandbox } from '@cloudflare/sandbox'
import { deriveThreadId, resolveSession } from '../lib/session'
import { previewBodySchema } from '../lib/preview-body'
import { ensureVerifiedTunnel, probeTunnelHealth } from '../lib/preview-tunnel'
import type {
  PreviewEnsureResponse,
  PreviewProbeResponse,
} from '../lib/preview-body'
import type { TunnelSandbox } from '../lib/preview-tunnel'

/** Must match every other getSandbox() for this id — see sandbox-provider.ts. */
const SANDBOX_OPTIONS = { transport: 'rpc' } as const

/**
 * The working project the preview serves, restored in preference order:
 * already there → copied from the baked pristine template (Dockerfile) →
 * scaffolded at run time. The last arm is not redundancy theatre: a thread's
 * container can outlive an image deploy (locally, a dev-server restart), and
 * an OLD-image container has no /opt/studio at all — first seen live as
 * "the preview server failed to start" because the missing directory made the
 * later `cd` fail. The trailing test makes "ran" mean "produced a project".
 */
const ENSURE_PROJECT =
  '(test -d /workspace/studio' +
  ' || cp -a /opt/studio /workspace/studio 2>/dev/null' +
  ' || (cd /workspace && hyperframes init studio --non-interactive --example blank))' +
  ' && test -s /workspace/studio/index.html'

/**
 * The preview server scans FORWARD from --port for a free one, so "is it
 * running" means probing a small range for `/__hyperframes_config`, not
 * checking 3002 alone. Echoes the first answering port, or nothing.
 */
const SCAN_PORTS =
  'for p in 3002 3003 3004 3005 3006; do' +
  ' if curl -sf --max-time 2 "http://127.0.0.1:$p/__hyperframes_config" >/dev/null;' +
  ' then echo "$p"; break; fi; done'

/**
 * `--background` is REQUIRED: without it the server dies when the exec
 * returns. No `--host` flag exists; the image sets HYPERFRAMES_PREVIEW_HOST.
 */
const START_PREVIEW =
  'cd /workspace/studio && hyperframes preview --port 3002 --no-open --background'

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const json = (body: unknown, status = 200, setCookie: string | null = null) => {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  if (setCookie !== null) headers.set('set-cookie', setCookie)
  return new Response(JSON.stringify(body), { status, headers })
}

/** The tail of an exec's output, for error messages a human has to act on. */
function execDetail(result: { stdout: string; stderr: string }): string {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  if (text === '') return 'no output'
  return text.length > 300 ? `…${text.slice(-300)}` : text
}

async function findRunningPort(sandbox: TunnelSandbox): Promise<number | null> {
  const result = await sandbox.exec(SCAN_PORTS)
  if (!result.success) return null
  const port = Number(result.stdout.trim())
  return Number.isInteger(port) && port >= 3002 && port <= 3006 ? port : null
}

async function ensurePreview(
  sandbox: TunnelSandbox,
): Promise<PreviewEnsureResponse> {
  const prepared = await sandbox.exec(ENSURE_PROJECT)
  if (!prepared.success) {
    return {
      ok: false,
      error: `could not prepare the starter project at /workspace/studio: ${execDetail(prepared)}`,
    }
  }

  let port = await findRunningPort(sandbox)
  if (port === null) {
    const started = await sandbox.exec(START_PREVIEW)
    if (!started.success) {
      return {
        ok: false,
        error: `the preview server failed to start: ${execDetail(started)}`,
      }
    }
    // The server backgrounds itself and takes a moment to bind.
    for (let attempt = 0; attempt < 10 && port === null; attempt++) {
      // oxlint-disable-next-line no-await-in-loop
      await wait(1000)
      // oxlint-disable-next-line no-await-in-loop
      port = await findRunningPort(sandbox)
    }
  }
  if (port === null) {
    // The start exec succeeded but nothing is answering — ask the CLI's own
    // process registry what it thinks before giving up, so the error carries
    // something actionable instead of a shrug.
    const status = await sandbox.exec(
      'cd /workspace/studio && hyperframes preview --status 2>&1 | tail -5',
    )
    return {
      ok: false,
      error: `the preview server did not come up on any expected port (status: ${execDetail(status)})`,
    }
  }

  const tunnel = await ensureVerifiedTunnel(sandbox, port)
  if (!tunnel.ok) return { ok: false, error: tunnel.error }
  const project = await detectProjectName(sandbox, port)
  return { ok: true, url: tunnel.url, port, project }
}

/**
 * Which project is the running server actually serving? Asked of the server
 * itself rather than assumed, because the agent may have restarted the
 * preview from a re-scaffolded project directory.
 */
async function detectProjectName(
  sandbox: TunnelSandbox,
  port: number,
): Promise<string> {
  const config = await sandbox.exec(
    `curl -s --max-time 3 http://127.0.0.1:${port}/__hyperframes_config`,
  )
  if (config.success) {
    try {
      const parsed: unknown = JSON.parse(config.stdout)
      if (parsed !== null && typeof parsed === 'object') {
        const name: unknown = Reflect.get(parsed, 'projectName')
        if (typeof name === 'string' && name !== '') return name
      }
    } catch {
      // Unparseable config — fall through to the baked default.
    }
  }
  return 'studio'
}

export const Route = createFileRoute('/api/preview')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: {
          handler: async ({ request }) => {
            let raw: unknown
            try {
              raw = await request.json()
            } catch {
              return json({ error: 'invalid JSON body' }, 400)
            }
            const parsed = previewBodySchema.safeParse(raw)
            if (!parsed.success) {
              return json(
                { error: parsed.error.issues[0]?.message ?? 'invalid body' },
                400,
              )
            }
            const body = parsed.data

            if (body.action === 'probe') {
              const healthy = await probeTunnelHealth(body.url)
              const response: PreviewProbeResponse = { healthy }
              return json(response)
            }

            // ensure — same identity contract as /api/run: derive, never
            // trust; persist a first-time visitor's session cookie.
            const { sessionId, setCookie } = resolveSession(request)
            const threadId = await deriveThreadId(sessionId, body.threadKey)

            try {
              const sandbox = getSandbox(env.Sandbox, threadId, SANDBOX_OPTIONS)
              const result = await ensurePreview(sandbox)
              return json(result, 200, setCookie)
            } catch (error) {
              console.error('[api/preview] ensure error:', error)
              const result: PreviewEnsureResponse = {
                ok: false,
                error: error instanceof Error ? error.message : 'preview error',
              }
              return json(result, 502, setCookie)
            }
          },
        },
      }),
  },
})
