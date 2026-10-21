import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { todayISO } from '../../lib/date'
import { useTeams } from '../../store/teamsStore'

/** "내 공간 ▾": switch between the personal space and the teams. */
export function SpaceSwitcher() {
  const { teams, loaded, load } = useTeams()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const location = useLocation()
  const current = teams.find((t) => location.pathname.startsWith(`/team/${t.id}`))

  useEffect(() => {
    if (!loaded) void load()
  }, [loaded, load])
  useEffect(() => setOpen(false), [location.pathname])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const item = 'flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm hover:bg-subtle'
  return (
    <div ref={ref} className="relative">
      <button
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-9 max-w-48 items-center gap-1.5 rounded-[10px] border border-line px-3 text-sm font-medium hover:bg-subtle"
      >
        <span className="truncate">{current ? current.name : '내 공간'}</span>
        <span aria-hidden="true" className="text-xs text-muted">
          ▾
        </span>
      </button>
      {open && (
        <div role="menu" aria-label="공간 전환" className="absolute top-11 left-0 z-40 flex w-64 flex-col gap-0.5 rounded-xl border border-line bg-surface p-1.5 shadow-lg">
          <Link role="menuitem" to={`/day/${todayISO()}`} className={item}>
            <span>내 공간</span>
            {!current && <span className="text-xs text-accent dark:text-accent-bright">현재</span>}
          </Link>
          {teams.length > 0 && <div className="mx-3 my-1 border-t border-line" />}
          {teams.map((t) => (
            <Link role="menuitem" key={t.id} to={`/team/${t.id}`} className={item}>
              <span className="truncate">{t.name}</span>
              <span className="shrink-0 text-xs text-muted">{t.id === current?.id ? '현재' : `${t.members}명`}</span>
            </Link>
          ))}
          <div className="mx-3 my-1 border-t border-line" />
          <Link role="menuitem" to="/teams/new" className={`${item} text-accent dark:text-accent-bright`}>
            + 새 팀 만들기
          </Link>
        </div>
      )}
    </div>
  )
}
