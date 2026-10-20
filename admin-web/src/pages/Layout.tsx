import { useState } from 'react'
import { NavLink, Outlet } from 'react-router'
import { btn } from '../format'
import { useSession } from '../session'
import { IconDashboard, IconLog, IconLogout, IconMenu, IconShield, IconUsers, Logo, ThemeToggle } from '../ui'

/** The console frame: menu on the left (a drawer on narrow screens), page on the right. */
export function Layout() {
  const { account, logout } = useSession()
  const [open, setOpen] = useState(false)
  if (!account) return null
  const items = [
    { to: '/', label: '대시보드', Icon: IconDashboard, end: true },
    { to: '/users', label: '사용자', Icon: IconUsers },
    { to: '/audit', label: '관리 기록', Icon: IconLog },
    ...(account.role === 'super' ? [{ to: '/admins', label: '관리자 계정', Icon: IconShield }] : []),
  ]
  const nav = (
    <nav aria-label="관리 메뉴" className="flex flex-col gap-0.5">
      {items.map(({ to, label, Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            `flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm ${isActive ? 'bg-subtle font-semibold text-ink' : 'text-ink-2 hover:bg-subtle/60'}`
          }
        >
          <Icon size={17} />
          {label}
        </NavLink>
      ))}
    </nav>
  )

  return (
    <div className="flex min-h-dvh bg-ground text-ink">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col gap-6 border-r border-line bg-surface px-3 py-4 lg:flex">
        <div className="flex items-center gap-2 px-2.5">
          <Logo size={24} />
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-bold">Box Scheduler</span>
            <span className="text-[11px] text-muted">관리자 콘솔</span>
          </div>
        </div>
        {nav}
        <div className="mt-auto flex flex-col gap-2 border-t border-line px-1 pt-3">
          <NavLink to="/me" className="flex flex-col rounded-lg px-1.5 py-1 hover:bg-subtle">
            <span className="truncate text-sm font-medium">{account.name || account.email}</span>
            <span className="truncate text-[11px] text-muted">
              {account.role === 'super' ? '최고 관리자' : '운영자'} · {account.email}
            </span>
          </NavLink>
          <div className="flex items-center justify-between">
            <ThemeToggle />
            <button onClick={() => void logout()} className={btn.ghost}>
              <IconLogout size={16} /> 로그아웃
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface px-3 lg:hidden">
          <button aria-label="메뉴 열기" onClick={() => setOpen(true)} className={btn.ghost}>
            <IconMenu />
          </button>
          <Logo size={22} />
          <span className="text-sm font-bold">관리자 콘솔</span>
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </header>
        {open && (
          <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)}>
            <div className="flex h-full w-64 flex-col gap-4 bg-surface p-3" onClick={(e) => e.stopPropagation()}>
              {nav}
              <div className="mt-auto flex flex-col gap-1 border-t border-line pt-3">
                <NavLink to="/me" onClick={() => setOpen(false)} className="px-2.5 text-sm text-ink-2">
                  {account.email}
                </NavLink>
                <button onClick={() => void logout()} className={btn.ghost}>
                  <IconLogout size={16} /> 로그아웃
                </button>
              </div>
            </div>
          </div>
        )}
        <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-5 px-4 py-5 lg:px-8 lg:py-7">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
