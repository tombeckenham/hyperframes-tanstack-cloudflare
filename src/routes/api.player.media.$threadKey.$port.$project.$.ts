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
 * Worker-safe transfer: size-capped curl + base64 over exec stdout (never raw
 * binary, never unbounded). Same session/`threadId` derivation as `/api/player`.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { getSandbox } from '@cloudflare/sandbox'
import {
  assetCurlCommand,
  decodeBase64Payload,
  isPlayerPort,
  isPlayerProject,
  isPlayerThreadKey,
  isSafePlayerAssetPath,
  mimeForAssetPath,
} from '../lib/player-proxy'
import { deriveThreadId, resolveSession } from '../lib/session'

const SANDBOX_OPTIONS = { transport: 'rpc' } as const

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
              if (!result.success || result.stdout.trim() === '') {
                return new Response('asset not found', { status: 404 })
              }
              const bytes = decodeBase64Payload(result.stdout)
              if (bytes === null) {
                return new Response('asset transfer failed', { status: 502 })
              }

              const headers = new Headers({
                'content-type': mimeForAssetPath(assetPath),
                'content-length': String(bytes.byteLength),
                // Short private cache: same composition version is re-fetched
                // often during authoring; avoid long-lived CDN caching.
                'cache-control': 'private, max-age=60',
                'x-content-type-options': 'nosniff',
              })
              if (setCookie !== null) headers.set('set-cookie', setCookie)
              // Fresh ArrayBuffer copy — TS BodyInit rejects ArrayBufferLike /
              // SharedArrayBuffer views from `Uint8Array.buffer`.
              const body = new ArrayBuffer(bytes.byteLength)
              new Uint8Array(body).set(bytes)
              return new Response(body, { status: 200, headers })
            } catch (error) {
              console.error('[api/player/media] proxy error:', error)
              return new Response(
                error instanceof Error ? error.message : 'media proxy error',
                { status: 502 },
              )
            }
          },
        },
      }),
  },
})
