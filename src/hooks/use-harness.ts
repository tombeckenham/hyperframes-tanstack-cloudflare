/**
 * Which coding agent this deployment runs — `grok` or `claude-code` — from
 * `GET /api/harness`. Returns `null` until known (or if the lookup fails),
 * which hides harness-gated demo briefs rather than offering the agent a
 * brief it cannot fulfil. React Query keeps the result for the page lifetime
 * (`staleTime: Infinity`); the route also sends a short HTTP cache header.
 */
import { useQuery } from '@tanstack/react-query'
import { isHarnessName } from '@/lib/harness'
import type { HarnessName } from '@/lib/harness'

async function fetchHarness(): Promise<HarnessName> {
  const response = await fetch('/api/harness')
  if (!response.ok) throw new Error(`harness request ${response.status}`)
  const body: unknown = await response.json()
  if (body !== null && typeof body === 'object') {
    const harness: unknown = Reflect.get(body, 'harness')
    if (isHarnessName(harness)) return harness
  }
  throw new Error('malformed harness response')
}

export function useHarness(): HarnessName | null {
  const query = useQuery({
    queryKey: ['harness'],
    queryFn: fetchHarness,
    // Fixed per deployment — never worth refetching within a page's life.
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  return query.data ?? null
}
