/**
 * `GET /api/harness` — which coding agent this deployment runs (`grok` or
 * `claude-code`), resolved from the same Worker secrets the coordinator uses
 * (src/lib/harness.ts). The empty-state demo cards need it: some briefs lean
 * on harness-specific abilities (xAI Imagine image generation) and must only
 * be offered when that harness is active.
 *
 * The name is deployment-wide and not a secret. `useHarness` caches it for
 * the page lifetime; this route also sends `private, max-age=300`.
 */
import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'
import { resolveHarness } from '../lib/harness'
import type { HarnessName } from '../lib/harness'

export interface HarnessResponse {
  harness: HarnessName
}

/** Secrets are not in the generated `Env` type — read them structurally. */
function readSecret(source: object, name: string): string | undefined {
  const value: unknown = Reflect.get(source, name)
  return typeof value === 'string' && value !== '' ? value : undefined
}

export const Route = createFileRoute('/api/harness')({
  server: {
    handlers: ({ createHandlers }) =>
      createHandlers({
        GET: {
          handler: () => {
            try {
              const body: HarnessResponse = {
                harness: resolveHarness({
                  XAI_API_KEY: readSecret(env, 'XAI_API_KEY'),
                  ANTHROPIC_API_KEY: readSecret(env, 'ANTHROPIC_API_KEY'),
                }),
              }
              return new Response(JSON.stringify(body), {
                headers: {
                  'content-type': 'application/json',
                  'cache-control': 'private, max-age=300',
                },
              })
            } catch (error) {
              // No key configured — resolveHarness's message says what to set.
              return new Response(
                error instanceof Error
                  ? error.message
                  : 'no harness configured',
                { status: 500 },
              )
            }
          },
        },
      }),
  },
})
