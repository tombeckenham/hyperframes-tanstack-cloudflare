/**
 * Viewport gate for the studio's two layouts. `useSyncExternalStore` is the
 * SSR-correct way to read `matchMedia`: the server snapshot (desktop) renders
 * first and the real value swaps in on hydration without a mismatch warning —
 * a phone briefly sees the desktop tree, which is the cheapest honest option
 * when the server cannot know the viewport.
 */
import { useSyncExternalStore } from 'react'

/** Tailwind's `md` breakpoint — the split layout needs at least this. */
const DESKTOP_QUERY = '(min-width: 768px)'

function subscribe(onChange: () => void): () => void {
  const list = window.matchMedia(DESKTOP_QUERY)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  )
}
