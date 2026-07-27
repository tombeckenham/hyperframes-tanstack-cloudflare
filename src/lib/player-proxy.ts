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
 * Transfer is base64-over-exec with a hard size cap: raw binary over `exec`
 * stdout is unsafe, and Workers must not buffer multi‑tens‑of‑MB media into
 * memory. Images and small audio fit; large MP4s belong in Studio / R2 renders.
 */

/** Hard cap on a single proxied asset (decoded bytes). Keeps Worker memory safe. */
export const PLAYER_ASSET_MAX_BYTES = 4 * 1024 * 1024

/** curl wall clock for one asset / composition fetch. */
export const PLAYER_FETCH_TIMEOUT_SEC = 20

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
  return (
    `curl -sf --max-time ${PLAYER_FETCH_TIMEOUT_SEC} ` +
    `http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project)}/preview`
  )
}

/**
 * In-container curl of one asset, size-capped, base64 on stdout.
 * `--max-filesize` stops huge videos from filling the Worker.
 *
 * Downloads to a temp file FIRST, then encodes: piping curl straight into
 * base64 would make the exec's exit status the pipe tail's, so a mid-transfer
 * curl failure (`--max-time` on a slow asset, a `--max-filesize` abort with no
 * Content-Length) would serve the partial bytes as a complete 200 asset.
 * With the temp file, curl's own status is the exec's status and nothing is
 * emitted unless the download finished.
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
  // `base64 | tr -d '\n'` is portable across GNU and BSD base64 in the image.
  return (
    `f=$(mktemp) && curl -sf --max-time ${PLAYER_FETCH_TIMEOUT_SEC} ` +
    `--max-filesize ${PLAYER_ASSET_MAX_BYTES} -o "$f" ` +
    `http://127.0.0.1:${port}/api/projects/${encodeURIComponent(project)}/preview/${encoded}; ` +
    `s=$?; [ $s -eq 0 ] && base64 < "$f" | tr -d '\\n'; rm -f "$f"; exit $s`
  )
}

/** Decode strict base64 from sandbox stdout into bytes. */
export function decodeBase64Payload(b64: string): Uint8Array | null {
  const trimmed = b64.trim()
  if (trimmed === '') return null
  // Reject non-base64 early so atob does not throw on garbage stderr leaks.
  if (!/^[A-Za-z0-9+/]+=*$/u.test(trimmed)) return null
  try {
    const bin = atob(trimmed)
    if (bin.length > PLAYER_ASSET_MAX_BYTES) return null
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) {
      out[i] = bin.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
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
