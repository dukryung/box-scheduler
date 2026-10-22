import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import type { AppNotification } from '../../api/types'
import { Bell, Close } from '../../components/icons'
import { refreshPush } from '../../lib/push'
import { useNotifications } from '../../store/notificationsStore'

// Checked often while the page is visible, so a reminder pops up on time.
const POLL_MS = 15_000
const SHOW_MS = { reminder: 12_000, other: 8_000 }

/** Keeps the notifications fresh for the whole app and pops new ones up in the bottom-right corner. */
export function Toaster() {
  const { toasts, load } = useNotifications()

  useEffect(() => {
    void refreshPush()
    void load()
    const t = setInterval(() => document.visibilityState === 'visible' && void load(), POLL_MS)
    const onFocus = () => void load()
    const onVisible = () => document.visibilityState === 'visible' && void load()
    const onMessage = (e: MessageEvent) => e.data?.type === 'notification' && void load()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker?.removeEventListener('message', onMessage)
    }
  }, [load])

  if (!toasts.length) return null
  return (
    <section aria-label="새 알림" aria-live="polite" className="pointer-events-none fixed right-4 bottom-24 left-4 z-[60] flex flex-col items-stretch gap-2 md:right-6 md:bottom-6 md:left-auto md:w-[380px]">
      {toasts.map((n) => (
        <Toast key={n.id} n={n} />
      ))}
    </section>
  )
}

function Toast({ n }: { n: AppNotification }) {
  const { dismiss, read } = useNotifications()
  const navigate = useNavigate()
  const ms = n.kind === 'reminder' ? SHOW_MS.reminder : SHOW_MS.other
  const [paused, setPaused] = useState(false)
  const left = useRef(ms)
  const started = useRef(0)

  // Counts down while not hovered; hovering keeps it up.
  useEffect(() => {
    if (paused) return
    started.current = Date.now()
    const t = setTimeout(() => dismiss(n.id), left.current)
    return () => {
      clearTimeout(t)
      left.current -= Date.now() - started.current
    }
  }, [paused, dismiss, n.id])

  const open = () => {
    dismiss(n.id)
    void read([n.id])
    if (n.link) navigate(n.link)
  }
  const reminder = n.kind === 'reminder'
  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className={`pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border bg-surface p-3.5 pr-2.5 shadow-lg ${reminder ? 'border-accent/50' : 'border-line'}`}
    >
      <span aria-hidden="true" className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${reminder ? 'bg-accent text-white' : 'bg-accent-soft text-accent-ink'}`}>
        {reminder ? <span className="text-base leading-none">⏰</span> : <Bell size={16} />}
      </span>
      <button onClick={open} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
        <span className="text-sm font-semibold">{n.title}</span>
        {n.body && <span className="text-xs text-muted">{n.body}</span>}
        {n.link && <span className="mt-0.5 text-[11px] font-medium text-accent dark:text-accent-bright">{reminder ? '시간표 열기' : '열기'}</span>}
      </button>
      <button aria-label="알림 닫기" onClick={() => dismiss(n.id)} className="rounded-md p-1 text-muted hover:bg-subtle hover:text-ink">
        <Close size={14} />
      </button>
      <span
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-accent/60"
        style={{ animation: `toast-countdown ${ms}ms linear forwards`, animationPlayState: paused ? 'paused' : 'running' }}
      />
    </div>
  )
}
