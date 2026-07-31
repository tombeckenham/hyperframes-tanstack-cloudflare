/**
 * `GET /api/player/media/:threadKey/:port/:project/*` — composition assets
 * for the live Player, proxied from the caller's sandbox preview server.
 *
 * The composition HTML from `/api/player` is rewritten so `<base href>` points
 * here (see `src/lib/player-proxy.ts`). Relative paths like `assets/dolphin.jpg`
 * then hit this route on OUR origin, which curls the in-container preview
 * server and returns bytes. Without this, Studio (tunnel origin) shows images
 * while the Player (Worker origin) 404s them.
 *
 * Worker-safe transfer: size-capped curl (best-effort via Content-Length) +
 * hard-checked base64 decode, never raw binary over exec. Same session /
 * `threadId` derivation as `/api/player`.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getSandbox } from '@cloudflare/sandbox'
import {
  PLAYER_ASSET_MAX_BYTES,
  assetCurlCommand,
  classifyAssetFetchFailure,
  decodeBase64Payload,
  isPlayerPort,
  isPlayerProject,
  isPlayerThreadKey,
  isSafePlayerAssetPath,
  mimeForAssetPath,
  playerProxyResponse,
} from '../lib/player-proxy'
import { deriveThreadId, resolveSession } from '../lib/session'

/** Must match every other getSandbox() for this id — see sandbox-provider.ts. */
const SANDBOX_OPTIONS = { transport: 'rpc' } as const

function execDetail(result: { stdout: string; stderr: string }): string {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  if (text === '') return 'no output'
  return text.length > 300 ? `…${text.slice(-300)}` : text
}

export const Route = createFileRoute(
  '/api/player/media/$threadKey/$port/$project/$',
)({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          handler: async ({ request, params }) => {
            const threadKey = params.threadKey
            const project = params.project
            const port = Number(params.port)
            // TanStack splat: remaining path after the static segments.
            const assetPath = params._splat ?? ''

            if (!isPlayerThreadKey(threadKey)) {
              return new Response('invalid threadKey', { status: 400 })
            }
            if (!isPlayerPort(port)) {
              return new Response('invalid port', { status: 400 })
            }
            if (!isPlayerProject(project)) {
              return new Response('invalid project', { status: 400 })
            }
            if (!isSafePlayerAssetPath(assetPath)) {
              return new Response('invalid asset path', { status: 400 })
            }

            const { sessionId, setCookie } = resolveSession(request)
            const threadId = await deriveThreadId(sessionId, threadKey)

            try {
              const sandbox = getSandbox(env.Sandbox, threadId, SANDBOX_OPTIONS)
              const result = await sandbox.exec(
                assetCurlCommand(port, project, assetPath),
              )
              const failure = classifyAssetFetchFailure(result)
              if (failure !== null) {
                console.error(
                  `[api/player/media] fetch ${failure}:`,
                  execDetail(result),
                )
                if (failure === 'not_found') {
                  return playerProxyResponse(
                    'asset not found',
                    404,
                    { 'content-type': 'text/plain; charset=utf-8' },
                    setCookie,
                  )
                }
                if (failure === 'too_large') {
                  return playerProxyResponse(
                    `asset exceeds player proxy limit (${PLAYER_ASSET_MAX_BYTES} bytes)`,
                    413,
                    { 'content-type': 'text/plain; charset=utf-8' },
                    setCookie,
                  )
                }
                return playerProxyResponse(
                  failure === 'encode'
                    ? 'asset transfer failed'
                    : 'preview asset proxy failed',
                  502,
                  { 'content-type': 'text/plain; charset=utf-8' },
                  setCookie,
                )
              }

              const decoded = decodeBase64Payload(result.stdout)
              if (!decoded.ok) {
                console.error(
                  `[api/player/media] decode ${decoded.reason} (stdout ${result.stdout.length} chars)`,
                )
                if (decoded.reason === 'too_large') {
                  return playerProxyResponse(
                    `asset exceeds player proxy limit (${PLAYER_ASSET_MAX_BYTES} bytes)`,
                    413,
                    { 'content-type': 'text/plain; charset=utf-8' },
                    setCookie,
                  )
                }
                return playerProxyResponse(
                  'asset transfer failed',
                  502,
                  { 'content-type': 'text/plain; charset=utf-8' },
                  setCookie,
                )
              }

              const headers = {
                'content-type': mimeForAssetPath(assetPath),
                'content-length': String(decoded.bytes.byteLength),
                // Match composition HTML: authoring rewrites same asset paths
                // without a version query — never serve a stale dolphin.jpg.
                'cache-control': 'private, no-store',
                'x-content-type-options': 'nosniff',
              }
              // Fresh ArrayBuffer copy — TS BodyInit rejects ArrayBufferLike /
              // SharedArrayBuffer views from `Uint8Array.buffer`.
              const body = new ArrayBuffer(decoded.bytes.byteLength)
              new Uint8Array(body).set(decoded.bytes)
              return playerProxyResponse(body, 200, headers, setCookie)
            } catch (error) {
              console.error('[api/player/media] proxy error:', error)
              return playerProxyResponse(
                error instanceof Error ? error.message : 'media proxy error',
                502,
                { 'content-type': 'text/plain; charset=utf-8' },
                setCookie,
              )
            }
          },
        },
      }),
  },
})
