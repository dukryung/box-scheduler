import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../../api/client'
import type { Block, CalendarDay, CalendarMonth } from '../../api/types'
import { ChevronLeft, ChevronRight } from '../../components/icons'
import { card, doneStrike, iconButton } from '../../components/styles'
import { WEEKDAYS, addMonths, formatMonthTitle, monthGrid, monthOf, parseISODate, todayISO } from '../../lib/date'
import { slotToTime } from '../../lib/slots'
import { hm } from '../../lib/hm'
import { useIsMobile } from '../../lib/useIsMobile'
import { TONE_CLASS, toneVars } from '../day/colors'
import { BottomTabs, TopBar, ViewSwitch } from '../nav/ViewSwitch'

const weekdayColor = (i: number) => (i === 0 ? 'text-danger' : i === 6 ? 'text-accent-ink' : '')


export function MonthView({ month }: { month: string }) {
  const navigate = useNavigate()
  const mobile = useIsMobile()
  const [data, setData] = useState<CalendarMonth | null>(null)
  const [error, setError] = useState<string | null>(null)
  const today = todayISO()
  const isCurrentMonth = monthOf(today) === month
  const [selected, setSelected] = useState(isCurrentMonth ? today : `${month}-01`)

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
  const rate = totals.planned ? Math.round((totals.done / totals.planned) * 100) : null
  const selectedDay = monthOf(selected) === month ? selected : `${month}-01`

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink md:h-dvh">
      <TopBar>
        <div className="flex flex-1 items-center gap-1 md:flex-none">
          <button onClick={() => navigate(`/month/${addMonths(month, -1)}`)} className={iconButton} aria-label="이전 달">
            <ChevronLeft size={18} />
          </button>
          <div className="flex flex-1 flex-col items-center md:flex-none md:px-2.5">
            <h1 className="text-[17px] font-semibold tracking-tight md:text-lg">{formatMonthTitle(month)}</h1>
            <span className="text-xs text-muted md:hidden">
              {rate === null ? '계획 없음' : `완료율 ${rate}% · 계획 ${hm(totals.planned)}`}
            </span>
          </div>
          <button onClick={() => navigate(`/month/${addMonths(month, 1)}`)} className={iconButton} aria-label="다음 달">
            <ChevronRight size={18} />
          </button>
          {!isCurrentMonth && (
            <button
              onClick={() => navigate(`/month/${monthOf(today)}`)}
              className="ml-1.5 h-9 shrink-0 rounded-[10px] border border-line px-3 text-sm text-ink-2 hover:bg-subtle"
            >
              이번 달
            </button>
          )}
        </div>
        <div className="ml-auto hidden items-center gap-5 text-[13px] text-muted md:flex">
          <span>
            완료율 <strong className="font-semibold text-ink">{rate === null ? '–' : `${rate}%`}</strong>
          </span>
          <span>
            계획 <strong className="font-mono font-semibold text-ink">{hm(totals.planned)}</strong>
          </span>
        </div>
        <ViewSwitch view="month" date={isCurrentMonth ? today : `${month}-01`} />
      </TopBar>

      {error && <p className="px-4 py-2 text-sm text-danger">불러오지 못했어요: {error}</p>}

      <main className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3 pb-[96px] md:px-6 md:py-5">
        <div className={`${card} flex min-h-0 flex-1 flex-col overflow-hidden px-1.5 pt-2 pb-1.5 md:p-0`}>
          <div className="grid grid-cols-7 md:border-b md:border-line">
            {WEEKDAYS.map((w, i) => (
              <div
                key={w}
                className={`py-1 text-center text-[11px] font-semibold md:px-3 md:py-2.5 md:text-left md:text-xs ${weekdayColor(i) || 'text-faint md:text-muted'}`}
              >
                {w}
              </div>
            ))}
          </div>
          <div
            className="grid flex-1 grid-cols-7 gap-y-0.5 md:gap-y-0"
            style={{ gridTemplateRows: mobile ? undefined : `repeat(${grid.length / 7}, minmax(7.5rem, 1fr))` }}
          >
            {grid.map((iso, i) =>
              mobile ? (
                <MobileDayCell
                  key={iso}
                  iso={iso}
                  inMonth={monthOf(iso) === month}
                  isToday={iso === today}
                  selected={iso === selectedDay}
                  day={days[iso]}
                  onSelect={() => setSelected(iso)}
                />
              ) : (
                <DayCell
                  key={iso}
                  iso={iso}
                  lastRow={i >= grid.length - 7}
                  inMonth={monthOf(iso) === month}
                  isToday={iso === today}
                  day={days[iso]}
                />
              ),
            )}
          </div>
        </div>

        {mobile && <Agenda date={selectedDay} />}
      </main>

      <BottomTabs view="month" date={isCurrentMonth ? today : `${month}-01`} />
    </div>
  )
}

interface CellProps {
  iso: string
  lastRow: boolean
  inMonth: boolean
  isToday: boolean
  day: CalendarDay | undefined
}

function DayCell({ iso, lastRow, inMonth, isToday, day }: CellProps) {
  const d = parseISODate(iso)
  const more = day ? day.total - day.items.length : 0
  const wd = d.getDay()

  return (
    <Link
      to={`/day/${iso}`}
      aria-label={`${d.getMonth() + 1}월 ${d.getDate()}일${day ? `, 일정 ${day.total}개` : ''}`}
      className={[
        'flex min-w-0 flex-col gap-1.5 px-2.5 pt-2 pb-2.5 hover:bg-ground/70',
        wd === 6 ? '' : 'border-r border-grid',
        lastRow ? '' : 'border-b border-grid',
        inMonth ? '' : 'bg-ground/50',
      ].join(' ')}
    >
      <span
        className={[
          'flex h-[26px] w-[26px] items-center justify-center self-start rounded-full font-mono text-[13px]',
          isToday ? 'bg-accent font-semibold text-white' : weekdayColor(wd),
          inMonth ? '' : 'opacity-40',
        ].join(' ')}
      >
        {d.getDate()}
      </span>

      {day && (
        <>
          <ul className="flex min-w-0 flex-col gap-[3px]">
            {day.items.map((it, i) => (
              <li
                key={i}
                style={toneVars(it.color)}
                className={`${TONE_CLASS} flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-[3px] text-xs font-medium`}
              >
                <span className="shrink-0 font-mono text-[11px] opacity-80">{slotToTime(it.startSlot)}</span>
                <span className={`truncate ${it.done ? doneStrike : ''}`}>{it.title}</span>
              </li>
            ))}
            {more > 0 && <li className="pl-1.5 text-xs text-muted">+{more}개 더</li>}
          </ul>

          {day.plannedBoxes > 0 && day.doneBoxes > 0 && (
            <span className="mt-auto block h-1 rounded-full bg-subtle" title={`완료 ${day.doneBoxes} / 계획 ${day.plannedBoxes} 박스`}>
              <span className="block h-1 rounded-full bg-accent" style={{ width: `${(day.doneBoxes / day.plannedBoxes) * 100}%` }} />
            </span>
          )}
        </>
      )}
    </Link>
  )
}

interface MobileCellProps {
  iso: string
  inMonth: boolean
  isToday: boolean
  selected: boolean
  day: CalendarDay | undefined
  onSelect: () => void
}

function MobileDayCell({ iso, inMonth, isToday, selected, day, onSelect }: MobileCellProps) {
  const d = parseISODate(iso)
  const wd = d.getDay()
  return (
    <button
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${d.getMonth() + 1}월 ${d.getDate()}일${day ? `, 일정 ${day.total}개` : ''}`}
      className="flex h-[50px] flex-col items-center gap-1 pt-1"
    >
      <span
        className={[
          'flex h-[30px] w-[30px] items-center justify-center rounded-full font-mono text-[13px]',
          selected ? 'bg-accent font-semibold text-white' : isToday ? 'font-semibold text-accent ring-1 ring-accent' : weekdayColor(wd),
          inMonth ? '' : 'opacity-35',
        ].join(' ')}
      >
        {d.getDate()}
      </span>
      <span className="flex h-[5px] gap-[3px]">
        {day?.items.map((it, i) => (
          <span key={i} className="h-[5px] w-[5px] rounded-full" style={{ backgroundColor: it.color ?? 'var(--app-accent)' }} />
        ))}
      </span>
    </button>
  )
}

/** The selected day's blocks under the phone calendar. */
function Agenda({ date }: { date: string }) {
  const [state, setState] = useState<{ date: string; blocks: Block[] } | null>(null)
  const d = parseISODate(date)

  useEffect(() => {
    let cancelled = false
    api.getDay(date).then((day) => !cancelled && setState({ date, blocks: day.blocks }))
    return () => {
      cancelled = true
    }
  }, [date])

  const blocks = state?.date === date ? state.blocks : null

  return (
    <section className={`${card} flex flex-col gap-1.5 px-3.5 pt-3.5 pb-2`} aria-label="선택한 날의 일정">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-bold">
          {d.getMonth() + 1}월 {d.getDate()}일 {WEEKDAYS[d.getDay()]}요일
        </h2>
        <Link to={`/day/${date}`} className="flex items-center gap-0.5 text-[13px] font-semibold text-accent">
          시간표 열기
          <ChevronRight size={14} />
        </Link>
      </div>
      <ul className="flex flex-col">
        {blocks?.length === 0 && <li className="border-t border-grid py-4 text-center text-sm text-muted">이 날은 일정이 없어요</li>}
        {blocks?.map((b) => (
          <li key={b.id} className="flex h-10 items-center gap-2.5 border-t border-grid">
            <span className="w-[84px] shrink-0 font-mono text-xs text-muted">
              {slotToTime(b.startSlot)}–{slotToTime(b.endSlot)}
            </span>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: b.color ?? 'var(--app-accent)' }} />
            <span className={`truncate text-sm ${b.done ? `text-faint ${doneStrike}` : 'font-medium'}`}>{b.title}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
