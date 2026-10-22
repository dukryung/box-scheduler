import { create } from 'zustand'
import { notifyApi } from '../api/client'
import type { AppNotification, NotifySettings } from '../api/types'

const MAX_TOASTS = 3

interface NotificationsState {
  items: AppNotification[]
  unread: number
  settings: NotifySettings | null
  /** New ones that arrived while the app was open, shown briefly in the corner. */
  toasts: AppNotification[]
  /** Newest createdAt seen; null before the first load (nothing old pops up). */
  since: string | null
  load: () => Promise<void>
  read: (ids?: string[]) => Promise<void>
  dismiss: (id: string) => void
}

/** The bell's list (the latest notifications and how many are unread) and the toasts. */
export const useNotifications = create<NotificationsState>((set, get) => ({
  items: [],
  unread: 0,
  settings: null,
  toasts: [],
  since: null,
  load: async () => {
    try {
      const r = await notifyApi.list()
      const { since, toasts } = get()
      const fresh = since === null ? [] : r.items.filter((n) => n.createdAt > since && !n.readAt && !toasts.some((t) => t.id === n.id)).reverse()
      const newest = r.items[0]?.createdAt ?? since ?? new Date(0).toISOString()
      set({
        items: r.items,
        unread: r.unread,
        settings: r.settings,
        since: since === null || newest > since ? newest : since,
        toasts: [...toasts, ...fresh].slice(-MAX_TOASTS),
      })
    } catch {
      /* the bell just stays as it was */
    }
  },
  read: async (ids) => {
    const now = new Date().toISOString()
    const hit = (n: AppNotification) => !n.readAt && (!ids || ids.includes(n.id))
    set({ items: get().items.map((n) => (hit(n) ? { ...n, readAt: now } : n)), unread: ids ? Math.max(0, get().unread - get().items.filter(hit).length) : 0 })
    await notifyApi.read(ids).catch(() => {})
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}))
