/**
 * Live Player composition proxy helpers.
 *
 * The preview server injects
 *   `<base href="/api/projects/<project>/preview/">`
 * so relative assets (`assets/dolphin.jpg`) resolve against that path on the
 * *document* origin. The Player loads HTML from our Worker (`/api/player`), so
 * those asset URLs would 404 on the Worker unless rewritten to a route that
 * proxies the bytes out of the caller's sandbox.
 *
 * Asset transfer is base64-over-exec with a size cap (composition HTML stays
 * plain text on stdout). Raw binary over `exec` stdout is unsafe, and Workers
 * must not buffer multi‑tens‑of‑MB media into memory. Images and small audio
 * fit; large MP4s belong in Studio / R2 renders.
 */

/** Hard cap on a single proxied asset (decoded bytes). Keeps Worker memory safe. */
export const PLAYER_ASSET_MAX_BYTES = 4 * 1024 * 1024

/** curl wall clock for one asset / composition fetch. */
export const PLAYER_FETCH_TIMEOUT_SEC = 20

/** stderr marker written by `assetCurlCommand` so the Worker can map failures. */
export const PLAYER_ASSET_ERR_PREFIX = 'PLAYER_ASSET_ERR'

const SAFE_PROJECT = /^[A-Za-z0-9._-]{1,64}$/u
const SAFE_THREAD_KEY = /^[A-Za-z0-9._-]{1,128}$/u

/** Same port rules as `/api/player` (never the sandbox control plane). */
export function isPlayerPort(port: number): boolean {
  return (
    Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 3000
  )
}

export function isPlayerProject(project: string): boolean {
  return SAFE_PROJECT.test(project)
}

export function isPlayerThreadKey(threadKey: string): boolean {
  return SAFE_THREAD_KEY.test(threadKey)
}

/**
 * Asset path under the preview base. Rejects traversal and anything that is
 * not a boring relative path (no schemes, no leading slash).
 */
export function isSafePlayerAssetPath(path: string): boolean {
  if (path === '' || path.length > 512) return false
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) {
    return false
  }
  if (path.includes('..') || path.includes(':')) return false
  return /^[A-Za-z0-9._/-]+$/u.test(path)
}

/** Directory base for relative composition assets (trailing slash required). */
export function playerMediaBasePath(
  threadKey: string,
  port: number,
  project: string,
): string {
  return (
    `/api/player/media/${encodeURIComponent(threadKey)}` +
    `/${port}/${encodeURIComponent(project)}/`
  )
}

/**
 * Point the composition's `<base href>` (and absolute preview asset URLs) at
 * our Worker media proxy so relative `assets/…` resolve same-origin.
 *
 * Absolute `/api/projects/<project>/preview/` strings are rewritten globally
 * (intentional for injected path maps; project names are charset-restricted
 * so collisions stay unlikely). Injects into an existing `<head>` when no
 * `<base>` is present.
 */
export function rewritePlayerAssetBase(
  html: string,
  threadKey: string,
  port: number,
  project: string,
): string {
  const base = playerMediaBasePath(threadKey, port, project)
  const studioPrefix = `/api/projects/${project}/preview/`

  let out = html.replace(
    /<base\b[^>]*\bhref\s*=\s*["']\/api\/projects\/[^"']+\/preview\/?["'][^>]*>/giu,
    `<base href="${base}">`,
  )

  // Absolute preview paths in attrs/scripts (e.g. injected maps) that skip <base>.
  if (out.includes(studioPrefix)) {
    out = out.split(studioPrefix).join(base)
  }

  if (!/<base\b/iu.test(out)) {
    out = out.replace(
      /<head\b[^>]*>/iu,
      (open) => `${open}<base href="${base}">`,
    )
  }

  return out
}

/** In-container curl of the composition HTML (text stdout — not base64). */
export function compositionCurlCommand(port: number, project: string): string {
  // -S with -s: show errors even when silent (logs via stderr on failure).
  return (
    `curl -sfS --max-time ${PLAYER_FETCH_TIMEOUT_SEC} ` +
    `http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project)}/preview`
  )
}

/**
 * In-container curl of one asset, size-capped, base64 on stdout.
 *
 * Downloads to a temp file FIRST, then encodes: a pipe would make the exec
 * status the pipe tail's, so a mid-transfer curl failure (e.g. `--max-time`)
 * could leave partial stdout treated as a complete 200 asset. With the temp
 * file, nothing is base64'd unless the download finished with HTTP 200.
 *
 * `--max-filesize` rejects oversized bodies when the server advertises
 * Content-Length (curl exit 63); `decodeBase64Payload` is the hard backstop
 * when size is unknown. Failures write `PLAYER_ASSET_ERR …` to stderr so the
 * Worker can map 404 / oversize / upstream instead of labeling everything
 * "not found".
 *
 * Encode failures also fail the exec. Trailing `[ $s -eq 0 ]` — NEVER `exit`:
 * sandbox exec runs in a persistent shell session, and `exit` kills it.
 */
export function assetCurlCommand(
  port: number,
  project: string,
  assetPath: string,
): string {
  const encoded = assetPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  const url =
    `http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project)}` +
    `/preview/${encoded}`
  // No -f: we branch on %{http_code} so 404 ≠ timeout ≠ oversize.
  // base64 status is checked alone (no pipefail); strip newlines when emitting.
  return (
    `f=$(mktemp) && ` +
    `code=$(curl -sS --max-time ${PLAYER_FETCH_TIMEOUT_SEC} ` +
    `--max-filesize ${PLAYER_ASSET_MAX_BYTES} -o "$f" -w '%{http_code}' '${url}'); ` +
    `s=$?; ` +
    `if [ $s -eq 0 ] && [ "$code" = "200" ]; then ` +
    `b64=$(base64 < "$f"); enc=$?; rm -f "$f"; ` +
    `if [ $enc -eq 0 ] && [ -n "$b64" ]; then ` +
    `printf '%s' "$b64" | tr -d '\\n'; s=0; ` +
    `else echo "${PLAYER_ASSET_ERR_PREFIX} encode" >&2; s=1; fi; ` +
    `else ` +
    `echo "${PLAYER_ASSET_ERR_PREFIX} curl_status=$s http=$code" >&2; ` +
    `rm -f "$f"; ` +
    `if [ $s -eq 0 ]; then s=1; fi; ` +
    `fi; ` +
    `[ $s -eq 0 ]`
  )
}

/** Why an asset exec failed — drives HTTP status on the media route. */
export type AssetFetchFailureKind =
  | 'not_found'
  | 'too_large'
  | 'encode'
  | 'upstream'

/**
 * Map sandbox exec outcome to a failure kind. `null` means success with
 * non-empty stdout (caller still decodes).
 */
export function classifyAssetFetchFailure(result: {
  success: boolean
  stdout: string
  stderr: string
}): AssetFetchFailureKind | null {
  if (result.success && result.stdout.trim() !== '') return null

  const detail = `${result.stderr}\n${result.stdout}`
  if (detail.includes(`${PLAYER_ASSET_ERR_PREFIX} encode`)) return 'encode'

  // curl status 63 = --max-filesize; also match the tag we write.
  if (
    /curl_status=63\b/u.test(detail) ||
    /Maximum file size exceeded/iu.test(detail)
  ) {
    return 'too_large'
  }

  const httpMatch = detail.match(/\bhttp=(\d{3})\b/u)
  if (httpMatch?.[1] === '404') return 'not_found'
  if (httpMatch?.[1]?.startsWith('4') === true) return 'not_found'

  return 'upstream'
}

export type DecodeBase64Result =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: 'empty' | 'invalid' | 'too_large' }

/** Decode strict base64 from sandbox stdout into bytes. */
export function decodeBase64Payload(b64: string): DecodeBase64Result {
  const trimmed = b64.trim()
  if (trimmed === '') return { ok: false, reason: 'empty' }
  // Reject non-base64 early so atob does not throw on garbage stderr leaks.
  if (!/^[A-Za-z0-9+/]+=*$/u.test(trimmed)) {
    return { ok: false, reason: 'invalid' }
  }
  try {
    const bin = atob(trimmed)
    if (bin.length > PLAYER_ASSET_MAX_BYTES) {
      return { ok: false, reason: 'too_large' }
    }
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i)
    }
    return { ok: true, bytes: out }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}

/**
 * Attach the session cookie when minted. Must be used on every response after
 * `resolveSession` — including 4xx/5xx — or a failed first hit orphans the id.
 */
export function playerProxyResponse(
  body: BodyInit,
  status: number,
  headersInit: HeadersInit,
  setCookie: string | null,
): Response {
  const headers = new Headers(headersInit)
  if (setCookie !== null) headers.set('set-cookie', setCookie)
  return new Response(body, { status, headers })
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  cube: 'text/plain; charset=utf-8',
}

export function mimeForAssetPath(path: string): string {
  const base = path.split('/').pop() ?? path
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return 'application/octet-stream'
  const ext = base.slice(dot + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}
