/**
 * The `.dark` class on `<html>` is the only theme mechanism Tailwind's
 * `@custom-variant dark` gives us, and nothing in the scaffold ever applied it —
 * so the entire `.dark` block in `src/styles.css` was unreachable until this
 * module existed.
 *
 * Split across two moments:
 *   1. An inline script in `__root.tsx` (`THEME_INIT_SCRIPT`) applies the class
 *      before first paint, so a dark-preference visitor never sees a light
 *      flash. It must be dependency-free string JS — it runs before hydration.
 *   2. This store keeps the running app and the class in sync afterwards.
 */
import { Store } from '@tanstack/store'

export type Theme = 'light' | 'dark'

const STORAGE_KEY = 'hf-theme'

/**
 * Pre-hydration boot script. Shares the storage key with {@link setTheme} by
 * interpolation, and falls back to `prefers-color-scheme` the same way — with
 * one deliberate divergence: a tampered/garbage stored value reads as "not
 * dark" here, while `initialTheme` validates and falls back to the OS
 * preference. Reachable only by hand-editing localStorage; not worth the
 * script bytes to reconcile.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  STORAGE_KEY,
)});var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;if(d)document.documentElement.classList.add("dark")}catch(e){}})()`

const isTheme = (value: unknown): value is Theme =>
  value === 'light' || value === 'dark'

/** SSR-safe: on the server there is no preference to read, default light. */
function initialTheme(): Theme {
  if (typeof window === 'undefined') return 'light'
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (isTheme(stored)) return stored
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light'
  } catch {
    return 'light'
  }
}

export const themeStore = new Store<Theme>(initialTheme())

export function setTheme(theme: Theme): void {
  themeStore.setState(() => theme)
  document.documentElement.classList.toggle('dark', theme === 'dark')
  try {
    window.localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Storage can be unavailable (private mode); the class still applied.
  }
}

export function toggleTheme(): void {
  setTheme(themeStore.state === 'dark' ? 'light' : 'dark')
}
