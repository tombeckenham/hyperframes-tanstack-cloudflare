/**
 * Verified preview tunnels, shared between the agent's `exposePreview` host
 * tool (src/tools/preview.ts) and the studio's `/api/preview` endpoint
 * (src/routes/api.preview.ts).
 *
 * Two failure modes shape everything here:
 *
 * 1. `sandbox.tunnels.get(port)` is idempotent per port and returns the CACHED
 *    tunnel record from DO storage without checking that the cloudflared
 *    process (or the server behind it) still exists. The first live run hit
 *    exactly that — a dead tunnel handed back as a 502. So a URL is only
 *    returned after the tunnel actually answered, and a stale record is torn
 *    down and re-minted once.
 *
 * 2. The Worker's OWN network path cannot be trusted to reach a fresh
 *    `*.trycloudflare.com` hostname. Seen live in local dev: the host's
 *    resolver (Tailscale MagicDNS → an ISP upstream) returned nothing for a
 *    brand-new tunnel hostname while 1.1.1.1, the container, and the
 *    browser's own DoH all resolved it fine — and the Worker-side probe
 *    "verified" a perfectly healthy tunnel as dead, destroyed it, and failed
 *    the re-mint the same way. So end-to-end verification runs FROM INSIDE
 *    the container (curl through the public URL: edge → tunnel → origin),
 *    whose DNS works in every environment; and the browser-facing health
 *    probe ({@link probeTunnelHealth}) only declares death on evidence, never
 *    on its own inability to connect.
 *
 * Typed structurally (not against `Sandbox`) so the pure parts stay node-safe
 * and the callers can pass whatever `getSandbox()` returned.
 */

/** The slice of a sandbox handle tunnel verification needs. */
export interface TunnelSandbox {
  exec(
    command: string,
  ): Promise<{ success: boolean; stdout: string; stderr: string }>
  tunnels: {
    get(port: number): Promise<{ url: string }>
    destroy(port: number): Promise<void>
  }
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Does the tunnel answer end to end — container → Cloudflare edge → tunnel →
 * origin? Probed from INSIDE the container (see failure mode 2 above). Any
 * relayed origin response counts, including 404s; 000 (no connection) and
 * 5xx (edge could not reach the origin) do not.
 */
async function tunnelAnswers(
  sandbox: TunnelSandbox,
  url: string,
): Promise<boolean> {
  const probe = await sandbox.exec(
    `curl -s -o /dev/null -w '%{http_code}' --max-time 8 "${url}/"`,
  )
  const status = Number(probe.stdout.trim())
  return probe.success && Number.isInteger(status) && status > 0 && status < 500
}

/** Retry the probe with a per-caller patience budget (see call sites). */
async function tunnelAnswersEventually(
  sandbox: TunnelSandbox,
  url: string,
  attempts: number,
  delayMs: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    // oxlint-disable-next-line no-await-in-loop
    if (attempt > 0) await wait(delayMs)
    // oxlint-disable-next-line no-await-in-loop
    if (await tunnelAnswers(sandbox, url)) return true
  }
  return false
}

/**
 * Patience budgets, asymmetric on purpose. A CACHED record that does not
 * answer within a couple of probes is almost certainly stale (its cloudflared
 * died with a previous container instance) — lingering on it only delays the
 * fix, which is re-minting. A FRESH tunnel is the opposite: the process is
 * definitely alive, but edge registration routinely takes tens of seconds —
 * seen live: a re-minted tunnel "failed" a ~14s window and was serving 200s
 * moments later. So the fresh probe waits up to ~40s before declaring defeat.
 */
const CACHED_ATTEMPTS = 2
const FRESH_ATTEMPTS = 12
const PROBE_DELAY_MS = 3000

/**
 * Is anything listening on `port` INSIDE the container? Catches the
 * wrong-port case — the preview server SCANS FORWARD from its --port for a
 * free one.
 */
export async function originListening(
  sandbox: TunnelSandbox,
  port: number,
): Promise<boolean> {
  const probe = await sandbox.exec(
    `curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:${port}/`,
  )
  const status = probe.stdout.trim()
  return probe.success && status !== '000' && status !== ''
}

export type TunnelResult =
  | { ok: true; url: string; reestablished: boolean }
  | { ok: false; error: string }

/**
 * Cached-or-fresh tunnel for `port`, verified end to end from inside the
 * container; a stale record is destroyed and re-minted once. The caller has
 * already confirmed something is listening on the port (see
 * {@link originListening}).
 */
export async function ensureVerifiedTunnel(
  sandbox: TunnelSandbox,
  port: number,
): Promise<TunnelResult> {
  let tunnel = await sandbox.tunnels.get(port)
  if (
    await tunnelAnswersEventually(
      sandbox,
      tunnel.url,
      CACHED_ATTEMPTS,
      PROBE_DELAY_MS,
    )
  ) {
    return { ok: true, url: tunnel.url, reestablished: false }
  }

  await sandbox.tunnels.destroy(port)
  tunnel = await sandbox.tunnels.get(port)
  if (
    await tunnelAnswersEventually(
      sandbox,
      tunnel.url,
      FRESH_ATTEMPTS,
      PROBE_DELAY_MS,
    )
  ) {
    return { ok: true, url: tunnel.url, reestablished: true }
  }

  return {
    ok: false,
    error: `the tunnel could not reach port ${port} even after re-establishing it — the server may be crashing`,
  }
}

/** The edge's HTTP status for `url`, or null when no response came back. */
async function edgeStatus(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    return response.status
  } catch {
    return null
  }
}

/**
 * Does the tunnel's DNS record still exist? Asked over DNS-over-HTTPS so the
 * answer does not depend on the host's resolver (failure mode 2). Returns
 * null when DoH itself was unreachable — i.e. we are blind, not informed.
 */
async function dnsRecordExists(hostname: string): Promise<boolean | null> {
  try {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      },
    )
    if (!response.ok) return null
    const data = (await response.json()) as {
      Status?: number
      Answer?: Array<unknown>
    }
    if (data.Status !== 0) return false
    return Array.isArray(data.Answer) && data.Answer.length > 0
  } catch {
    return null
  }
}

/**
 * The browser-facing health poll, run WITHOUT touching the sandbox (a slept
 * container must be detected, not woken). Death is declared only on
 * evidence:
 *   - the edge answered with a status → healthy iff < 500 (5xx is the
 *     edge-cannot-reach-origin signature);
 *   - no response at all → the hostname is looked up over DoH: record gone →
 *     the tunnel is dead; record present (or DoH unreachable) → OUR path to
 *     the edge is broken, not the tunnel — report healthy, because the
 *     user's browser may well reach it fine (Chrome's secure DNS did, live,
 *     while the host resolver returned nothing).
 */
export async function probeTunnelHealth(url: string): Promise<boolean> {
  const status = await edgeStatus(url)
  if (status !== null) return status < 500
  const exists = await dnsRecordExists(new URL(url).hostname)
  if (exists === null) return true
  return exists
}
