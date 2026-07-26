/**
 * Real `spawn().kill()` for the Cloudflare sandbox handle.
 *
 * Package default (`CloudflareHandle.spawn`) streams via `exec({ stream: true })`
 * and implements `kill` as a no-op — there is no process id to cancel. That is
 * fine for one-shot harness CLIs that exit when the turn ends, but Grok Build
 * on Cloudflare uses ACP over WebSocket: each turn starts `grok agent serve`
 * on a fixed port, and dispose relies on `kill()` to free it. A no-op kill
 * leaves the serve process bound; the next user message cannot start a new
 * serve (or connects to the stale one with a new secret) and surfaces as a
 * closed WebSocket. See GitHub issue #30.
 *
 * Fix: wrap the shell command so the process writes its PID to a file, then
 * implement `kill` as `kill -TERM/-KILL` against that PID. The streaming
 * path stays the package's proven `exec({ stream: true, onOutput })`.
 */

/** POSIX single-quote escape for embedding a string in `sh -c '…'`. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Build a shell command that records its PID then `exec`s into `command`
 * (same PID after exec — so kill targets the live process, not a parent).
 *
 * `pidFile` must be a path under our control (no shell metacharacters).
 */
export function wrapCommandWithPidFile(
  command: string,
  pidFile: string,
): string {
  return `sh -c ${shQuote(`echo $$ > ${pidFile}; exec ${command}`)}`
}

/** Mint a pid-file path unique to one spawn (safe for the wrap/kill scripts). */
export function newSpawnPidFile(): string {
  return `/tmp/hf-spawn-${crypto.randomUUID()}.pid`
}

/**
 * SIGTERM then SIGKILL the PID recorded in `pidFile`. Idempotent when the
 * file or process is already gone.
 */
export async function killFromPidFile(
  exec: (command: string) => Promise<unknown>,
  pidFile: string,
): Promise<void> {
  const quoted = shQuote(pidFile)
  // Read once; ignore missing file. TERM, brief wait, KILL, then drop the file
  // so a later kill is a no-op rather than re-signalling a recycled PID.
  await exec(
    `pid=$(cat ${quoted} 2>/dev/null) || exit 0; ` +
      `if [ -z "$pid" ]; then rm -f ${quoted}; exit 0; fi; ` +
      `kill -TERM "$pid" 2>/dev/null || true; ` +
      `sleep 0.15; ` +
      `kill -KILL "$pid" 2>/dev/null || true; ` +
      `rm -f ${quoted}`,
  )
}

/**
 * Best-effort cleanup of a `grok agent serve` left behind by a previous turn
 * whose `kill` was a no-op (or never ran after DO eviction). Called when a
 * sandbox handle is created/resumed at the start of a run — before the new
 * ACP serve binds the port.
 *
 * The `[g]rok` pattern avoids the pkill process matching its own argv.
 */
export async function reapLeakedGrokServe(
  exec: (command: string) => Promise<unknown>,
): Promise<void> {
  await exec(
    `pkill -f '[g]rok agent' 2>/dev/null || pkill -f '[g]rok.*serve' 2>/dev/null || true`,
  )
}
