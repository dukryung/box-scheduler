import { create } from 'zustand'
import { api, type BrainDumpPatch } from '../api/client'
import type { BacklogItem } from '../api/types'
import { parseQuickAdd } from '../lib/quickAdd'

interface TasksState {
  items: BacklogItem[]
  loaded: boolean
  error: string | null
  load: () => Promise<void>
  /** Quick add: "계약서 검토 1시간 ~10/30 !" */
  add: (text: string) => Promise<void>
  update: (id: string, patch: BrainDumpPatch) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Moves an item onto a day's Brain Dump; it leaves the backlog. */
  moveToDay: (id: string, date: string) => Promise<boolean>
  /** After a linked block is checked off: done once the estimate is covered by done time. */
  syncAfterBlockDone: (itemId: string) => Promise<void>
  setError: (error: string | null) => void
}

const replaceById = (list: BacklogItem[], id: string, next: BacklogItem) => list.map((x) => (x.id === id ? next : x))

// Same optimistic pattern as the day store: change locally, roll back on failure.
export const useTasksStore = create<TasksState>((set, get) => ({
  items: [],
  loaded: false,
  error: null,

  load: async () => {
    try {
      const { items } = await api.listTasks()
      set({ items, loaded: true })
    } catch (e) {
      set({ error: (e as Error).message, loaded: true })
    }
  },

  add: async (text) => {
    const { title, estimateBoxes, dueDate, priority } = parseQuickAdd(text)
    if (!title) return
    try {
      const created = await api.createTask({ title, estimateBoxes, dueDate, priority })
      set((s) => ({ items: [...s.items, created] }))
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  update: async (id, patch) => {
    const before = get().items.find((it) => it.id === id)
    if (!before) return
    const optimistic = {
      ...before,
      ...patch,
      ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate || null } : {}),
      ...(patch.note !== undefined ? { note: patch.note || null } : {}),
    } as BacklogItem
    set((s) => ({ items: replaceById(s.items, id, optimistic) }))
    try {
      const updated = await api.updateBrainDump(id, patch)
      set((s) => ({ items: replaceById(s.items, id, { ...optimistic, ...updated }) }))
    } catch (e) {
      set((s) => ({ items: replaceById(s.items, id, before), error: (e as Error).message }))
    }
  },

  remove: async (id) => {
    const removed = get().items.find((it) => it.id === id)
    if (!removed) return
    set((s) => ({ items: s.items.filter((it) => it.id !== id) }))
    try {
      await api.deleteBrainDump(id)
    } catch (e) {
      set((s) => ({ items: [...s.items, removed], error: (e as Error).message }))
    }
  },

  moveToDay: async (id, date) => {
    const moved = get().items.find((it) => it.id === id)
    if (!moved) return false
    set((s) => ({ items: s.items.filter((it) => it.id !== id) }))
    try {
      await api.moveBrainDump(id, date)
      return true
    } catch (e) {
      set((s) => ({ items: [...s.items, moved], error: (e as Error).message }))
      return false
    }
  },

  syncAfterBlockDone: async (itemId) => {
    await get().load()
    const it = get().items.find((x) => x.id === itemId)
    if (!it) return
    const finished = it.scheduledBoxes > 0 && it.doneBoxes === it.scheduledBoxes && (!it.estimateBoxes || it.doneBoxes >= it.estimateBoxes)
    if (finished && it.status === 'open') await get().update(itemId, { status: 'done' })
    if (!finished && it.status === 'done' && it.doneBoxes < it.scheduledBoxes) await get().update(itemId, { status: 'open' })
  },

  setError: (error) => set({ error }),
}))
