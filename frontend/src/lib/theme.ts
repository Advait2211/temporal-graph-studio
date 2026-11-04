import { useEffect, useState, useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'

function read(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

const listeners = new Set<() => void>()

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t
  try { localStorage.setItem('tcg-theme', t) } catch { /* private mode */ }
  listeners.forEach((l) => l())
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    read,
    () => 'light',
  )
}

/** Resolved CSS variable values, recomputed when the theme flips (for canvas drawing). */
export function useCssVars<T extends string>(names: readonly T[]): Record<T, string> {
  const theme = useTheme()
  const [vals, setVals] = useState<Record<T, string>>(() => resolve(names))
  useEffect(() => { setVals(resolve(names)) }, [theme]) // eslint-disable-line react-hooks/exhaustive-deps
  return vals
}

function resolve<T extends string>(names: readonly T[]): Record<T, string> {
  const cs = getComputedStyle(document.documentElement)
  const out = {} as Record<T, string>
  for (const n of names) out[n] = cs.getPropertyValue(`--${n}`).trim()
  return out
}
