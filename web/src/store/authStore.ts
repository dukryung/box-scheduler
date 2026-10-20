import { create } from 'zustand'
import { authApi, setSignedOutHandler } from '../api/client'
import type { User } from '../api/types'

interface AuthState {
  /** undefined while the first check is running; null when signed out. */
  user: User | null | undefined
  load: () => Promise<void>
  setUser: (user: User | null) => void
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: undefined,
  load: async () => {
    try {
      set({ user: await authApi.me() })
    } catch {
      set({ user: null })
    }
  },
  setUser: (user) => set({ user }),
  logout: async () => {
    await authApi.logout().catch(() => {})
    // Drop everything loaded for this account.
    window.location.assign('/login')
  },
}))

setSignedOutHandler(() => {
  if (useAuth.getState().user) window.location.assign('/login?expired=1')
})
