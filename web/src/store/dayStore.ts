import { create } from 'zustand'
import { api, type BlockPatch, type BrainDumpPatch, type NewBlock } from '../api/client'
import type { Block, BrainDumpItem } from '../api/types'
import { todayISO } from '../lib/date'
import { parseQuickAdd } from '../lib/quickAdd'

const TEMP_PREFIX = 'tmp-'

export const isTempId = (id: string) => id.startsWith(TEMP_PREFIX)
const tempId = () => `${TEMP_PREFIX}${crypto.randomUUID()}`

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
  addBrainDump: (text: string) => Promise<void>
  updateBrainDump: (id: string, patch: BrainDumpPatch) => Promise<void>
  deleteBrainDump: (id: string) => Promise<void>
  /** Copies this day's open items to `to`; returns how many moved. */
  carryOver: (to: string) => Promise<number>
  setError: (error: string | null) => void
}

const replaceById = <T extends { id: string }>(list: T[], id: string, next: T) =>
  list.map((x) => (x.id === id ? next : x))

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
    const id = tempId()
    const optimistic: Block = { id, color: null, brainDumpId: null, done: false, source: 'manual', ...draft }
    set((s) => ({ blocks: [...s.blocks, optimistic] }))
    try {
      const created = await api.createBlock(draft)
      set((s) => ({ blocks: replaceById(s.blocks, id, created) }))
    } catch (e) {
      set((s) => ({ blocks: s.blocks.filter((b) => b.id !== id), error: (e as Error).message }))
    }
  },

  updateBlock: async (id, patch) => {
    const before = get().blocks.find((b) => b.id === id)
    if (!before) return
    set((s) => ({ blocks: replaceById(s.blocks, id, { ...before, ...patch }) }))
    try {
      const updated = await api.updateBlock(id, patch)
      set((s) => ({ blocks: replaceById(s.blocks, id, updated) }))
    } catch (e) {
      set((s) => ({ blocks: replaceById(s.blocks, id, before), error: (e as Error).message }))
      return
    }
    if (patch.done !== undefined && before.brainDumpId) syncItemDone(before.brainDumpId)
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

  addBrainDump: async (text) => {
    const { title, estimateBoxes } = parseQuickAdd(text)
    if (!title) return
    const date = get().date
    const id = tempId()
    const optimistic: BrainDumpItem = {
      id,
      date,
      title,
      estimateBoxes,
      priority: null,
      category: null,
      status: 'open',
      carriedFrom: null,
    }
    set((s) => ({ brainDump: [...s.brainDump, optimistic] }))
    try {
      const created = await api.createBrainDump({ date, title, estimateBoxes })
      set((s) => ({ brainDump: replaceById(s.brainDump, id, created) }))
    } catch (e) {
      set((s) => ({ brainDump: s.brainDump.filter((it) => it.id !== id), error: (e as Error).message }))
    }
  },

  updateBrainDump: async (id, patch) => {
    const before = get().brainDump.find((it) => it.id === id)
    if (!before) return
    set((s) => ({ brainDump: replaceById(s.brainDump, id, { ...before, ...patch }) }))
    try {
      const updated = await api.updateBrainDump(id, patch)
      set((s) => ({ brainDump: replaceById(s.brainDump, id, updated) }))
    } catch (e) {
      set((s) => ({ brainDump: replaceById(s.brainDump, id, before), error: (e as Error).message }))
    }
  },

  deleteBrainDump: async (id) => {
    const removed = get().brainDump.find((it) => it.id === id)
    if (!removed) return
    set((s) => ({ brainDump: s.brainDump.filter((it) => it.id !== id) }))
    try {
      await api.deleteBrainDump(id)
      // The server keeps linked blocks and nulls their link; mirror that.
      set((s) => ({ blocks: s.blocks.map((b) => (b.brainDumpId === id ? { ...b, brainDumpId: null } : b)) }))
    } catch (e) {
      set((s) => ({ brainDump: [...s.brainDump, removed], error: (e as Error).message }))
    }
  },

  carryOver: async (to) => {
    try {
      const moved = await api.carryOver(get().date, to)
      set((s) => ({
        brainDump: s.brainDump.map((it) => (it.status === 'open' ? { ...it, status: 'carried' } : it)),
      }))
      return moved.length
    } catch (e) {
      set({ error: (e as Error).message })
      return 0
    }
  },

  setError: (error) => set({ error }),
}))

/**
 * Keeps a brain dump item's done state in step with its blocks: done once every
 * linked block is done, reopened when one of them is unchecked.
 */
function syncItemDone(itemId: string) {
  const { blocks, brainDump, updateBrainDump } = useDayStore.getState()
  const item = brainDump.find((it) => it.id === itemId)
  if (!item) return
  const allDone = blocks.filter((b) => b.brainDumpId === itemId).every((b) => b.done)
  if (allDone && item.status === 'open') void updateBrainDump(itemId, { status: 'done' })
  if (!allDone && item.status === 'done') void updateBrainDump(itemId, { status: 'open' })
}
