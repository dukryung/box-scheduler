import { create } from 'zustand'
import { notifyApi } from '../api/client'
import type { AppNotification, NotifySettings } from '../api/types'

interface NotificationsState {
  items: AppNotification[]
  unread: number
  settings: NotifySettings | null
  load: () => Promise<void>
  read: (ids?: string[]) => Promise<void>
}

/** The bell's list: the latest notifications and how many are unread. */
export const useNotifications = create<NotificationsState>((set, get) => ({
  items: [],
  unread: 0,
  settings: null,
  load: async () => {
    try {
      const r = await notifyApi.list()
      set({ items: r.items, unread: r.unread, settings: r.settings })
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
}))
