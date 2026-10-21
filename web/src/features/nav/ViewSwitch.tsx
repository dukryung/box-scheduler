import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../../store/authStore'
import { Logo, TabDay, TabMonth, TabStats, TabTasks } from '../../components/icons'
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
          className={`rounded-lg px-3.5 py-1.5 text-sm ${
            view === t.view ? 'bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(21,23,28,0.08)]' : 'text-muted hover:text-ink'
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
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-surface pb-[max(env(safe-area-inset-bottom),8px)] md:hidden"
    >
      {targets(date).map(({ view: v, label, to, Icon }) => (
        <Link
          key={v}
          to={to}
          aria-current={view === v ? 'page' : undefined}
          className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${view === v ? 'font-semibold text-accent dark:text-accent-bright' : 'text-muted'}`}
        >
          <Icon size={22} />
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
    <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-surface px-4 py-3 md:px-6">
      <Link to={`/day/${todayISO()}`} aria-label="Box Scheduler 홈 (오늘)" title="오늘로 가기" className="hidden items-center gap-2.5 rounded-lg md:flex">
        <Logo />
        <span className="text-base font-bold tracking-tight">Box Scheduler</span>
      </Link>
      {children}
      <ThemeToggle className={phoneTheme ? '' : 'max-md:hidden'} />
      <AccountButton className={phoneTheme ? '' : 'max-md:hidden'} />
    </header>
  )
}


/** Initial of the signed-in person; opens 설정. */
function AccountButton({ className }: { className: string }) {
  const user = useAuth((s) => s.user)
  if (!user) return null
  const initial = (user.name || user.email).trim().charAt(0).toUpperCase()
  return (
    <Link
      to="/settings"
      aria-label={`계정 설정 (${user.email})`}
      title={user.email}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-bold text-accent-ink hover:brightness-95 ${className}`}
    >
      {initial}
    </Link>
  )
}
