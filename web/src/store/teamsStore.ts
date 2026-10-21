import { create } from 'zustand'
import { teamApi } from '../api/client'
import type { Team } from '../api/types'

interface TeamsState {
  teams: Team[]
  loaded: boolean
  load: () => Promise<void>
}

/** The teams the signed-in person belongs to (for the space switcher). */
export const useTeams = create<TeamsState>((set) => ({
  teams: [],
  loaded: false,
  load: async () => {
    try {
      set({ teams: (await teamApi.list()).teams, loaded: true })
    } catch {
      set({ loaded: true })
    }
  },
}))
