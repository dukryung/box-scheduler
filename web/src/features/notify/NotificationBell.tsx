import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { AppNotification } from '../../api/types'
import { Bell } from '../../components/icons'
import { useNotifications } from '../../store/notificationsStore'

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return '방금'
  if (s < 3600) return `${Math.floor(s / 60)}분 전`
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 🔔 in the header: unread count and the latest notifications (kept fresh by the Toaster). */
export function NotificationBell() {
  const { items, unread, load, read } = useNotifications()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const location = useLocation()

  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  const go = (n: AppNotification) => {
    setOpen(false)
    if (!n.readAt) void read([n.id])
    if (n.link) navigate(n.link)
  }
  return (
    <div ref={ref} className="relative">
      <button
        aria-label={unread ? `알림 ${unread}개 안 읽음` : '알림'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
          if (!open) void load()
        }}
        className="relative flex h-9 w-9 items-center justify-center rounded-[10px] text-ink-2 hover:bg-subtle md:border md:border-line md:bg-surface"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 font-mono text-[10px] font-bold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <section
          role="dialog"
          aria-label="알림 목록"
          className="fixed inset-x-3 top-16 z-40 flex max-h-[70dvh] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-lg md:absolute md:inset-x-auto md:top-11 md:right-0 md:w-96"
        >
          <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <h2 className="text-sm font-semibold">알림</h2>
            {unread > 0 && (
              <button className="text-xs text-accent hover:underline dark:text-accent-bright" onClick={() => void read()}>
                모두 읽음
              </button>
            )}
          </header>
          <ul className="flex-1 divide-y divide-line overflow-y-auto">
            {items.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted">아직 알림이 없어요</li>}
            {items.map((n) => (
              <li key={n.id}>
                <button onClick={() => go(n)} className={`flex w-full gap-2.5 px-4 py-3 text-left hover:bg-subtle ${n.readAt ? '' : 'bg-accent-soft/40'}`}>
                  <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className={`text-sm ${n.readAt ? 'text-ink-2' : 'font-semibold'}`}>
                      {n.title}
                      {!n.readAt && <span className="sr-only"> (안 읽음)</span>}
                    </span>
                    {n.body && <span className="text-xs text-muted">{n.body}</span>}
                    <span className="text-[11px] text-muted">{ago(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <footer className="border-t border-line px-4 py-2 text-right">
            <Link to="/settings#notifications" className="text-xs text-ink-2 hover:underline">
              알림 설정
            </Link>
          </footer>
        </section>
      )}

    </div>
  )
}
