import { create } from 'zustand'
import { api, type BlockPatch, type BrainDumpPatch, type NewBlock } from '../api/client'
import type { Block, BrainDumpItem } from '../api/types'
import { todayISO } from '../lib/date'
import { parseQuickAdd } from '../lib/quickAdd'
import { useTasksStore } from './tasksStore'

const TEMP_PREFIX = 'tmp-'

export const isTempId = (id: string) => id.startsWith(TEMP_PREFIX)
const tempId = () => `${TEMP_PREFIX}${crypto.randomUUID()}`

interface DayState {
  date: string
  blocks: Block[]
  brainDump: BrainDumpItem[]
  /** Backlog or other-day items that have a block on this day. */
  linkedItems: BrainDumpItem[]
  loading: boolean
  error: string | null

  setDate: (date: string) => Promise<void>
  /** Re-fetches the current day, e.g. after the server changed it in bulk. */
  reload: () => Promise<void>
  createBlock: (b: NewBlock) => Promise<void>
  updateBlock: (id: string, patch: BlockPatch) => Promise<void>
  deleteBlock: (id: string) => Promise<void>
  addBrainDump: (text: string) => Promise<void>
  updateBrainDump: (id: string, patch: BrainDumpPatch) => Promise<void>
  deleteBrainDump: (id: string) => Promise<void>
  /** Sends a Brain Dump item to the backlog ("나중에"). */
  moveToBacklog: (id: string) => Promise<void>
  /** Copies this day's open items to `to`; returns how many moved. */
  carryOver: (to: string) => Promise<number>
  setError: (error: string | null) => void
}

const replaceById = <T extends { id: string }>(list: T[], id: string, next: T) =>
  list.map((x) => (x.id === id ? next : x))

// Blocks and brain dump items are kept in step by the server (a block always has
// an item; done, renames, moves and deletes carry across). Edits apply locally
// right away, roll back if the server rejects them, and otherwise end with a
// quiet refetch so both sides show what the server did.
export const useDayStore = create<DayState>((set, get) => {
  /** Fetches the current day without the loading state. */
  const refresh = async () => {
    const date = get().date
    try {
      const day = await api.getDay(date)
      if (get().date === date) set({ blocks: day.blocks, brainDump: day.brainDump, linkedItems: day.linkedItems })
    } catch {
      // The next navigation or edit will try again.
    }
  }
  const refreshBacklog = () => void useTasksStore.getState().load()

  return {
    date: todayISO(),
    blocks: [],
    brainDump: [],
    linkedItems: [],
    loading: false,
    error: null,

    setDate: async (date) => {
      set({ date, loading: true })
      try {
        const day = await api.getDay(date)
        if (get().date !== date) return // a newer navigation won
        set({ blocks: day.blocks, brainDump: day.brainDump, linkedItems: day.linkedItems, loading: false })
      } catch (e) {
        if (get().date === date) set({ loading: false, error: (e as Error).message })
      }
    },

    reload: () => get().setDate(get().date),

    createBlock: async (draft) => {
      const id = tempId()
      const optimistic: Block = { id, color: null, brainDumpId: null, done: false, source: 'manual', ...draft }
      set((s) => ({ blocks: [...s.blocks, optimistic] }))
      try {
        const created = await api.createBlock(draft)
        set((s) => ({ blocks: replaceById(s.blocks, id, created) }))
        await refresh() // the block may have brought a new brain dump item
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
      if (patch.title !== undefined || patch.date !== undefined || patch.done !== undefined) {
        await refresh()
        if (patch.done !== undefined) refreshBacklog()
      }
    },

    deleteBlock: async (id) => {
      const removed = get().blocks.find((b) => b.id === id)
      if (!removed) return
      set((s) => ({ blocks: s.blocks.filter((b) => b.id !== id) }))
      try {
        await api.deleteBlock(id)
        await refresh() // its item goes too when this was the item's last block
        refreshBacklog()
      } catch (e) {
        set((s) => ({ blocks: [...s.blocks, removed], error: (e as Error).message }))
      }
    },

    addBrainDump: async (text) => {
      const { title, estimateBoxes, dueDate, priority } = parseQuickAdd(text)
      if (!title) return
      const date = get().date
      const id = tempId()
      const optimistic: BrainDumpItem = {
        id,
        date,
        title,
        estimateBoxes,
        priority,
        category: null,
        status: 'open',
        carriedFrom: null,
        dueDate,
        note: null,
      }
      set((s) => ({ brainDump: [...s.brainDump, optimistic] }))
      try {
        const created = await api.createBrainDump({ date, title, estimateBoxes, dueDate, priority })
        set((s) => ({ brainDump: replaceById(s.brainDump, id, created) }))
      } catch (e) {
        set((s) => ({ brainDump: s.brainDump.filter((it) => it.id !== id), error: (e as Error).message }))
      }
    },

    updateBrainDump: async (id, patch) => {
      const { brainDump, linkedItems, blocks } = get()
      const list = brainDump.some((it) => it.id === id) ? 'brainDump' : 'linkedItems'
      const before = (list === 'brainDump' ? brainDump : linkedItems).find((it) => it.id === id)
      if (!before) return
      const blocksBefore = blocks
      set((s) => ({
        [list]: replaceById(s[list], id, { ...before, ...patch } as BrainDumpItem),
        // Checking an item on or off does the same to its blocks.
        blocks:
          patch.status === 'done' || patch.status === 'open'
            ? s.blocks.map((b) => (b.brainDumpId === id ? { ...b, done: patch.status === 'done' } : b))
            : s.blocks,
      }))
      try {
        await api.updateBrainDump(id, patch)
        await refresh()
        if (patch.status !== undefined) refreshBacklog()
      } catch (e) {
        set((s) => ({ [list]: replaceById(s[list], id, before), blocks: blocksBefore, error: (e as Error).message }))
      }
    },

    deleteBrainDump: async (id) => {
      const { brainDump, blocks } = get()
      const removed = brainDump.find((it) => it.id === id)
      if (!removed) return
      // Its blocks are deleted with it.
      set((s) => ({ brainDump: s.brainDump.filter((it) => it.id !== id), blocks: s.blocks.filter((b) => b.brainDumpId !== id) }))
      try {
        await api.deleteBrainDump(id)
      } catch (e) {
        set((s) => ({ brainDump: [...s.brainDump, removed], blocks, error: (e as Error).message }))
      }
    },

    moveToBacklog: async (id) => {
      const moved = get().brainDump.find((it) => it.id === id)
      if (!moved) return
      set((s) => ({ brainDump: s.brainDump.filter((it) => it.id !== id) }))
      try {
        await api.moveBrainDump(id, null)
        await refresh()
        refreshBacklog()
      } catch (e) {
        set((s) => ({ brainDump: [...s.brainDump, moved], error: (e as Error).message }))
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
  }
})
