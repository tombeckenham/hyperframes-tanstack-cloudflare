/**
 * `GET /api/artifacts?threadKey=…` — what this thread has published, for the
 * preview pane's Renders tab.
 *
 * The browser never learns a `threadId`, let alone supplies one: the id is
 * derived here from the session cookie + the client's `threadKey`, exactly as
 * `/api/run` does (see src/lib/session.ts). A visitor without a session cookie
 * gets a fresh namespace — which is correctly empty — and the cookie so their
 * next request lands in the same one.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { z } from 'zod'
import { deriveThreadId, resolveSession } from '../lib/session'
import { PREVIEW_PREFIX, RENDER_PREFIX } from '../lib/artifact-keys'

const searchSchema = z.object({ threadKey: z.string().min(1).max(128) })

export interface ArtifactEntry {
  url: string
  key: string
  bytes: number
  uploadedAt: string
}

export interface ArtifactList {
  compositions: Array<ArtifactEntry>
  renders: Array<ArtifactEntry>
}

const toEntry = (route: '/p/' | '/r/', object: R2Object): ArtifactEntry => ({
  url: `${route}${object.key}`,
  key: object.key,
  bytes: object.size,
  uploadedAt: object.uploaded.toISOString(),
})

export const Route = createFileRoute('/api/artifacts')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          handler: async ({ request }) => {
            const parsed = searchSchema.safeParse({
              threadKey: new URL(request.url).searchParams.get('threadKey'),
            })
            if (!parsed.success) {
              return new Response(
                JSON.stringify({ error: 'threadKey query param required' }),
                {
                  status: 400,
                  headers: { 'content-type': 'application/json' },
                },
              )
            }

            const { sessionId, setCookie } = resolveSession(request)
            const threadId = await deriveThreadId(
              sessionId,
              parsed.data.threadKey,
            )

            const [previews, renders] = await Promise.all([
              env.RENDERS.list({ prefix: `${PREVIEW_PREFIX}${threadId}/` }),
              env.RENDERS.list({ prefix: `${RENDER_PREFIX}${threadId}/` }),
            ])

            const body: ArtifactList = {
              compositions: previews.objects.map((o) => toEntry('/p/', o)),
              renders: renders.objects.map((o) => toEntry('/r/', o)),
            }

            const headers = new Headers({
              'content-type': 'application/json',
              'cache-control': 'no-store',
            })
            if (setCookie !== null) headers.set('set-cookie', setCookie)
            return new Response(JSON.stringify(body), { status: 200, headers })
          },
        },
      }),
  },
})
