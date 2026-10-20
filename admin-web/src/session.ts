import { create } from 'zustand'
import { api, setSignedOutHandler, type Admin, type Stage } from './api'

interface SessionState {
  /** undefined while checking; null when signed out. */
  account: Admin | null | undefined
  stage: Stage | null
  load: () => Promise<void>
  set: (account: Admin, stage: Stage) => void
  logout: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  account: undefined,
  stage: null,
  load: async () => {
    try {
      const r = await api.me()
      set({ account: r.account, stage: r.stage })
    } catch {
      set({ account: null, stage: null })
    }
  },
  set: (account, stage) => set({ account, stage }),
  logout: async () => {
    await api.logout().catch(() => {})
    window.location.assign('/login')
  },
}))

setSignedOutHandler((stage) => {
  if (stage) useSession.setState({ stage })
  else if (useSession.getState().account) window.location.assign('/login?expired=1')
})
