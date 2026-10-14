import { create } from 'zustand'
import { api, type BlockPatch, type NewBlock } from '../api/client'
import type { Block, BrainDumpItem } from '../api/types'
import { todayISO } from '../lib/date'

const TEMP_PREFIX = 'tmp-'

export const isTempId = (id: string) => id.startsWith(TEMP_PREFIX)

interface DayState {
  date: string
  blocks: Block[]
  brainDump: BrainDumpItem[]
  loading: boolean
  error: string | null

  setDate: (date: string) => Promise<void>
  createBlock: (b: NewBlock) => Promise<void>
  updateBlock: (id: string, patch: BlockPatch) => Promise<void>
  deleteBlock: (id: string) => Promise<void>
  setError: (error: string | null) => void
}

// Edits apply to local state immediately and roll back if the server rejects them
// (e.g. 409 when a block would overlap another).
export const useDayStore = create<DayState>((set, get) => ({
  date: todayISO(),
  blocks: [],
  brainDump: [],
  loading: false,
  error: null,

  setDate: async (date) => {
    set({ date, loading: true })
    try {
      const day = await api.getDay(date)
      if (get().date !== date) return // a newer navigation won
      set({ blocks: day.blocks, brainDump: day.brainDump, loading: false })
    } catch (e) {
      if (get().date === date) set({ loading: false, error: (e as Error).message })
    }
  },

  createBlock: async (draft) => {
    const tempId = `${TEMP_PREFIX}${crypto.randomUUID()}`
    const optimistic: Block = {
      id: tempId,
      color: null,
      brainDumpId: null,
      done: false,
      source: 'manual',
      ...draft,
    }
    set((s) => ({ blocks: [...s.blocks, optimistic] }))
    try {
      const created = await api.createBlock(draft)
      set((s) => ({ blocks: s.blocks.map((b) => (b.id === tempId ? created : b)) }))
    } catch (e) {
      set((s) => ({ blocks: s.blocks.filter((b) => b.id !== tempId), error: (e as Error).message }))
    }
  },

  updateBlock: async (id, patch) => {
    const before = get().blocks.find((b) => b.id === id)
    if (!before) return
    set((s) => ({ blocks: s.blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)) }))
    try {
      const updated = await api.updateBlock(id, patch)
      set((s) => ({ blocks: s.blocks.map((b) => (b.id === id ? updated : b)) }))
    } catch (e) {
      set((s) => ({ blocks: s.blocks.map((b) => (b.id === id ? before : b)), error: (e as Error).message }))
    }
  },

  deleteBlock: async (id) => {
    const removed = get().blocks.find((b) => b.id === id)
    if (!removed) return
    set((s) => ({ blocks: s.blocks.filter((b) => b.id !== id) }))
    try {
      await api.deleteBlock(id)
    } catch (e) {
      set((s) => ({ blocks: [...s.blocks, removed], error: (e as Error).message }))
    }
  },

  setError: (error) => set({ error }),
}))
