import { useEffect, useSyncExternalStore } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'theme'
const media = () => window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

/** Sets <html data-theme> and the browser bar color from the preference. */
function apply(pref: ThemePref) {
  const dark = pref === 'dark' || (pref === 'system' && media().matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector<HTMLMetaElement>('meta[name=theme-color]')?.setAttribute('content', dark ? '#1C1A18' : '#FFFFFF')
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  current = pref
  apply(pref)
  listeners.forEach((l) => l())
}

let current: ThemePref = typeof window === 'undefined' ? 'system' : readPref()

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The saved preference; while it is 'system', follows OS changes live. */
export function useThemePref(): ThemePref {
  const pref = useSyncExternalStore(subscribe, () => current)
  useEffect(() => {
    if (pref !== 'system') return
    const m = media()
    const onChange = () => apply('system')
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [pref])
  return pref
}

export const nextThemePref = (p: ThemePref): ThemePref => (p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system')
