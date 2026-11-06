import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router'
import { useAuth } from '../../store/authStore'
import { NotificationBell } from '../notify/NotificationBell'
import { SpaceSwitcher } from '../teams/SpaceSwitcher'
import { Gear, LogOut, Logo, TabDay, TabMonth, TabStats, TabTasks, UserIcon } from '../../components/icons'
import { ThemeToggle } from '../../components/ThemeToggle'
import { monthOf, todayISO } from '../../lib/date'

/** 'other' = a page outside the four views (설정); nothing is marked current. */
export type View = 'day' | 'month' | 'tasks' | 'stats' | 'other'

interface Props {
  view: View
  /** Day to open in day view, and whose month to open in month view. */
  date: string
}

const targets = (date: string) =>
  [
    { view: 'day', label: '일', to: `/day/${date}`, Icon: TabDay },
    { view: 'month', label: '월', to: `/month/${monthOf(date)}`, Icon: TabMonth },
    { view: 'tasks', label: '보관함', to: '/tasks', Icon: TabTasks },
    { view: 'stats', label: '통계', to: '/stats', Icon: TabStats },
  ] as const

/** Segmented 일/월/통계 control in the desktop top bar. */
export function ViewSwitch({ view, date }: Props) {
  return (
    <nav aria-label="보기 전환" className="hidden rounded-[10px] bg-subtle p-[3px] md:flex">
      {targets(date).map((t) => (
        <Link
          key={t.view}
          to={t.to}
          aria-current={view === t.view ? 'page' : undefined}
          className={`rounded-lg px-3.5 py-1.5 text-sm transition-colors ${
            view === t.view ? 'bg-surface font-bold text-ink shadow-[0_1px_2px_rgba(28,25,23,0.08),0_2px_8px_rgba(28,25,23,0.06)]' : 'text-muted hover:text-ink'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

/** Bottom tab bar on phones. */
export function BottomTabs({ view, date }: Props) {
  return (
    <nav
      aria-label="화면 전환"
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface/90 pb-[max(env(safe-area-inset-bottom),8px)] backdrop-blur-md md:hidden"
    >
      {targets(date).map(({ view: v, label, to, Icon }) => (
        <Link
          key={v}
          to={to}
          aria-current={view === v ? 'page' : undefined}
          className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${view === v ? 'font-bold text-ink' : 'text-muted'}`}
        >
          <span className={`flex h-7 w-11 items-center justify-center rounded-full transition-colors ${view === v ? 'bg-accent-soft text-accent dark:text-accent-bright' : ''}`}>
            <Icon size={20} />
          </span>
          {label}
        </Link>
      ))}
    </nav>
  )
}

/**
 * White top bar; the logo shows from tablet width up. The theme switch sits at the
 * right end from tablet width up; on phones a view opts in with `phoneTheme`.
 */
export function TopBar({ children, phoneTheme = false }: { children: ReactNode; phoneTheme?: boolean }) {
  return (
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-surface/85 px-4 py-3 backdrop-blur-md md:px-6">
      <Link to={`/day/${todayISO()}`} aria-label="Box Scheduler 홈 (오늘)" title="오늘로 가기" className="hidden items-center gap-2.5 rounded-lg md:flex">
        <Logo />
        <span className="text-base font-bold tracking-tight">Box Scheduler</span>
      </Link>
      <span className="hidden md:block">
        <SpaceSwitcher />
      </span>
      {children}
      <NotificationBell />
      <ThemeToggle className={phoneTheme ? '' : 'max-md:hidden'} />
      <AccountButton className={phoneTheme ? '' : 'max-md:hidden'} />
    </header>
  )
}


/** The signed-in person's initial; opens a menu with 프로필, 설정 and 로그아웃. */
function AccountButton({ className }: { className: string }) {
  const { user, logout } = useAuth()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!user) return null
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase()
  const item = 'flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm text-ink-2 hover:bg-subtle hover:text-ink'
  const here = (path: string) => (location.pathname === path ? 'bg-subtle font-semibold text-ink' : '')
  return (
    <div ref={box} className={`relative shrink-0 ${className}`}>
      <button
        ref={button}
        type="button"
        aria-label={`계정 메뉴 (${user.email})`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={user.email}
        onClick={() => setOpen((v) => !v)}
        className={`flex h-9 w-9 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-ink hover:brightness-95 ${open ? 'ring-2 ring-accent/40' : ''}`}
      >
        {initial}
      </button>
      {open && (
        <div role="menu" aria-label="계정" className="absolute top-full right-0 z-50 mt-2 w-60 rounded-xl border border-line bg-surface p-1.5 shadow-xl">
          <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-ink">{initial}</span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-ink">{user.name || user.email.split('@')[0]}</span>
              <span className="truncate text-xs text-muted">{user.email}</span>
            </span>
          </div>
          <div className="mb-1 border-t border-line" />
          <Link role="menuitem" to="/profile" className={`${item} ${here('/profile')}`}>
            <UserIcon size={16} /> 프로필
          </Link>
          <Link role="menuitem" to="/settings" className={`${item} ${here('/settings')}`}>
            <Gear size={16} /> 설정
          </Link>
          <div className="my-1 border-t border-line" />
          <button role="menuitem" type="button" onClick={() => void logout()} className={item}>
            <LogOut size={16} /> 로그아웃
          </button>
        </div>
      )}
    </div>
  )
}
