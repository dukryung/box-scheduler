import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../../api/client'
import type { CalendarDay, CalendarMonth } from '../../api/types'
import { WEEKDAYS, addMonths, formatMonthTitle, monthGrid, monthOf, parseISODate, todayISO } from '../../lib/date'
import { slotToTime } from '../../lib/slots'
import { DEFAULT_BLOCK_COLOR } from '../day/colors'
import { ViewSwitch } from '../nav/ViewSwitch'

const weekdayColor = (i: number) => (i === 0 ? 'text-rose-500' : i === 6 ? 'text-sky-600 dark:text-sky-400' : '')

export function MonthView({ month }: { month: string }) {
  const navigate = useNavigate()
  const [data, setData] = useState<CalendarMonth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const today = todayISO()
  const isCurrentMonth = monthOf(today) === month

  useEffect(() => {
    let cancelled = false
    api.getCalendar(month).then(
      (res) => {
        if (cancelled) return
        setData(res)
        setError(null)
      },
      (e: Error) => !cancelled && setError(e.message),
    )
    return () => {
      cancelled = true
    }
  }, [month])

  // Ignore a response still on screen from the previously viewed month.
  const days = data?.month === month ? data.days : {}
  const grid = monthGrid(month)
  const totals = Object.values(days).reduce(
    (t, d) => ({ planned: t.planned + d.plannedBoxes, done: t.done + d.doneBoxes }),
    { planned: 0, done: 0 },
  )

  return (
    <div className="flex h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <button
          onClick={() => navigate(`/month/${addMonths(month, -1)}`)}
          className="rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="이전 달"
        >
          ◀
        </button>
        <h1 className="min-w-32 text-center text-lg font-semibold">{formatMonthTitle(month)}</h1>
        <button
          onClick={() => navigate(`/month/${addMonths(month, 1)}`)}
          className="rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          aria-label="다음 달"
        >
          ▶
        </button>
        {!isCurrentMonth && (
          <button
            onClick={() => navigate(`/month/${monthOf(today)}`)}
            className="rounded-md border border-zinc-300 px-3 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            이번 달
          </button>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden text-sm text-zinc-500 tabular-nums sm:inline">
            완료 {totals.done} / 계획 {totals.planned} 박스
          </span>
          <ViewSwitch view="month" date={isCurrentMonth ? today : `${month}-01`} />
        </div>
      </header>

      {error && <p className="px-4 py-2 text-sm text-red-600">불러오지 못했어요: {error}</p>}

      <div className="grid grid-cols-7 border-b border-zinc-200 text-center text-xs text-zinc-500 dark:border-zinc-800">
        {WEEKDAYS.map((w, i) => (
          <div key={w} className={`py-1.5 ${weekdayColor(i)}`}>
            {w}
          </div>
        ))}
      </div>

      <div
        className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto"
        style={{ gridTemplateRows: `repeat(${grid.length / 7}, minmax(6.5rem, 1fr))` }}
      >
        {grid.map((iso) => (
          <DayCell key={iso} iso={iso} inMonth={monthOf(iso) === month} isToday={iso === today} day={days[iso]} />
        ))}
      </div>
    </div>
  )
}

interface CellProps {
  iso: string
  inMonth: boolean
  isToday: boolean
  day: CalendarDay | undefined
}

function DayCell({ iso, inMonth, isToday, day }: CellProps) {
  const d = parseISODate(iso)
  const more = day ? day.total - day.items.length : 0

  return (
    <Link
      to={`/day/${iso}`}
      aria-label={`${d.getMonth() + 1}월 ${d.getDate()}일${day ? `, 일정 ${day.total}개` : ''}`}
      className={[
        'flex min-w-0 flex-col gap-1 border-r border-b border-zinc-200 p-1.5 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900',
        inMonth ? '' : 'bg-zinc-50/60 dark:bg-zinc-900/40',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-6 w-6 items-center justify-center self-start rounded-full text-xs tabular-nums',
          isToday ? 'bg-indigo-600 font-semibold text-white' : weekdayColor(d.getDay()),
          inMonth ? '' : 'opacity-40',
        ].join(' ')}
      >
        {d.getDate()}
      </span>

      {day && (
        <>
          {/* Narrow screens: a dot per block instead of titles. */}
          <div className="flex flex-wrap gap-0.5 sm:hidden">
            {day.items.map((it, i) => (
              <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: it.color ?? DEFAULT_BLOCK_COLOR }} />
            ))}
            {more > 0 && <span className="text-[10px] leading-none text-zinc-500">+{more}</span>}
          </div>

          <ul className="hidden min-w-0 flex-col gap-0.5 text-xs sm:flex">
            {day.items.map((it, i) => (
              <li key={i} className="flex min-w-0 items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: it.color ?? DEFAULT_BLOCK_COLOR }} />
                <span className="shrink-0 text-zinc-400 tabular-nums">{slotToTime(it.startSlot)}</span>
                <span className={`truncate ${it.done ? 'text-zinc-400 line-through' : ''}`}>{it.title}</span>
              </li>
            ))}
            {more > 0 && <li className="pl-3 text-zinc-500">+{more}개 더</li>}
          </ul>

          {day.plannedBoxes > 0 && (
            <div className="mt-auto h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" title={`완료 ${day.doneBoxes} / 계획 ${day.plannedBoxes} 박스`}>
              <div className="h-full bg-emerald-500" style={{ width: `${(day.doneBoxes / day.plannedBoxes) * 100}%` }} />
            </div>
          )}
        </>
      )}
    </Link>
  )
}
