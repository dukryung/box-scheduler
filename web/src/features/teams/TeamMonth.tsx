import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { teamApi } from '../../api/client'
import type { TeamDetail, TeamTask } from '../../api/types'
import { ChevronLeft, ChevronRight } from '../../components/icons'
import { card } from '../../components/styles'
import { WEEKDAYS, addMonths, formatMonthTitle, isValidMonth, monthOf, parseISODate, todayISO } from '../../lib/date'
import { DAY_CAPACITY, STATUS_LABEL, dailyLoad, hoursText, isWeekend, loadStep, monthDays, periodText, taskSpan } from '../../lib/teamTasks'
import { TaskEditor } from './TeamTasks'

// Bars by status: open work in the accent, done work in teal.
const BAR_TONE = {
  todo: 'border border-accent/50 bg-accent-soft text-accent-ink',
  doing: 'bg-accent text-white',
  done: 'bg-done-soft text-done-ink',
} as const
// Daily load: the sequential orange ramp (validated with the stats heat strip); over capacity takes the darkest step plus a danger ring and "!".
const HEAT = ['', 'var(--viz-seq-1)', 'var(--viz-seq-2)', 'var(--viz-seq-3)', 'var(--viz-seq-4)', 'var(--viz-seq-6)']
const HEAT_INK = ['', 'text-ink', 'text-ink', 'text-ink', 'text-white dark:text-ink', 'text-white dark:text-[#1c1a18]']
const LEGEND = ['~2시간', '~4시간', '~6시간', '~8시간', '8시간 초과']

const personName = (m: { name: string; email: string }) => m.name || m.email.split('@')[0]

/** A month of team work: each task's period as a bar, then how much each person has on each day. */
export function TeamMonth({ team, meId }: { team: TeamDetail; meId: string }) {
  const today = todayISO()
  const [params, setParams] = useSearchParams()
  const asked = params.get('m') ?? ''
  const month = isValidMonth(asked) ? asked : monthOf(today)
  const setMonth = (m: string) => setParams({ tab: 'month', ...(m === monthOf(today) ? {} : { m }) }, { replace: true })
  const scroller = useRef<HTMLDivElement>(null)
  const [tasks, setTasks] = useState<TeamTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [person, setPerson] = useState('all')
  const [editing, setEditing] = useState<TeamTask | null>(null)

  const load = useCallback(async () => {
    try {
      setTasks((await teamApi.tasks(team.id)).tasks)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [team.id])
  useEffect(() => {
    void load()
  }, [load])

  // On narrow screens the month scrolls sideways: start with today in view.
  useEffect(() => {
    const box = scroller.current
    const cell = box?.querySelector<HTMLElement>('[data-today]')
    if (box && cell && box.scrollWidth > box.clientWidth) box.scrollLeft = Math.max(0, cell.offsetLeft - box.clientWidth / 2)
  }, [month, tasks])

  const days = monthDays(month)
  const first = days[0]
  const last = days[days.length - 1]
  const cols = { gridTemplateColumns: `minmax(132px, 200px) repeat(${days.length}, minmax(26px, 1fr))` }

  const rows = useMemo(
    () =>
      (tasks ?? [])
        .map((t) => ({ t, span: taskSpan(t) }))
        .filter(({ t, span }) => span && span.from <= last && span.to >= first && (person === 'all' || t.assignees.some((a) => a.userId === person)))
        .sort((a, b) => a.span!.from.localeCompare(b.span!.from) || a.span!.to.localeCompare(b.span!.to)),
    [tasks, first, last, person],
  )
  const undated = (tasks ?? []).filter((t) => !taskSpan(t) && t.status !== 'done').length
  const loads = useMemo(() => dailyLoad(tasks ?? [], today), [tasks, today])
  const people = person === 'all' ? team.memberList : team.memberList.filter((m) => m.userId === person)

  const dayHead = (
    <>
      {days.map((d) => {
        const wd = parseISODate(d).getDay()
        return (
          <div key={d} data-day={d} data-today={d === today ? '' : undefined} className={`flex flex-col items-center py-1.5 text-[11px] leading-tight ${isWeekend(d) ? 'bg-subtle/70 text-muted' : 'text-ink-2'}`}>
            <span className={`font-mono ${d === today ? 'flex h-5 w-5 items-center justify-center rounded-full bg-accent font-semibold text-white' : ''}`}>{Number(d.slice(8))}</span>
            <span className="text-[10px] text-muted">{WEEKDAYS[wd]}</span>
          </div>
        )
      })}
    </>
  )
  const stripes = (row: number) =>
    days.map((d, i) => (
      <div
        key={d}
        style={{ gridColumn: i + 2, gridRow: row }}
        className={`${isWeekend(d) ? 'bg-subtle/70' : ''} ${d === today ? 'border-x border-accent/40' : ''}`}
        aria-hidden="true"
      />
    ))

  return (
    <section aria-label="팀 월간 일정" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button aria-label="이전 달" onClick={() => setMonth(addMonths(month, -1))} className="rounded-lg p-1.5 text-ink-2 hover:bg-subtle">
            <ChevronLeft size={18} />
          </button>
          <h2 className="min-w-[110px] text-center text-[17px] font-semibold">{formatMonthTitle(month)}</h2>
          <button aria-label="다음 달" onClick={() => setMonth(addMonths(month, 1))} className="rounded-lg p-1.5 text-ink-2 hover:bg-subtle">
            <ChevronRight size={18} />
          </button>
        </div>
        {month !== monthOf(today) && (
          <button onClick={() => setMonth(monthOf(today))} className="rounded-lg border border-line-strong px-2.5 py-1 text-[13px] text-ink-2 hover:bg-subtle">
            이번 달
          </button>
        )}
        <select aria-label="사람 필터" value={person} onChange={(e) => setPerson(e.target.value)} className="ml-auto h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px]">
          <option value="all">모든 사람</option>
          {team.memberList.map((m) => (
            <option key={m.userId} value={m.userId}>
              {personName(m)}
              {m.userId === meId ? ' (나)' : ''}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div ref={scroller} className={`${card} relative overflow-x-auto`}>
        <div className="min-w-[900px]">
          <section aria-label="업무 일정">
            <div className="grid border-b border-line" style={cols}>
              <div className="sticky left-0 z-20 flex items-end bg-surface px-3 py-1.5 text-xs font-semibold text-ink-2">업무</div>
              {dayHead}
            </div>
            {tasks === null ? (
              <p className="px-4 py-6 text-sm text-muted">불러오는 중…</p>
            ) : rows.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted">이 달에 기간이 걸친 업무가 없어요</p>
            ) : (
              rows.map(({ t, span }) => {
                const from = span!.from < first ? first : span!.from
                const to = span!.to > last ? last : span!.to
                const late = t.status !== 'done' && t.dueDate !== null && t.dueDate < today
                const label = `${t.title} · ${periodText(t)} · ${STATUS_LABEL[t.status]}${late ? ' · 마감 지남' : ''}${t.assignees.length ? ` · ${t.assignees.map(personName).join(', ')}` : ''}`
                return (
                  <div key={t.id} className="grid border-b border-line last:border-b-0" style={cols}>
                    <button
                      onClick={() => setEditing(t)}
                      style={{ gridColumn: 1, gridRow: 1 }}
                      className="sticky left-0 z-20 flex min-w-0 flex-col items-start bg-surface px-3 py-1.5 text-left hover:bg-subtle"
                    >
                      <span className={`w-full truncate text-[13px] font-medium ${t.status === 'done' ? 'text-done-ink' : ''}`}>{t.title}</span>
                      <span className="w-full truncate text-[11px] text-muted">{t.assignees.length ? t.assignees.map(personName).join(', ') : '담당자 없음'}</span>
                    </button>
                    {stripes(1)}
                    <button
                      aria-label={label}
                      title={label}
                      onClick={() => setEditing(t)}
                      style={{ gridColumn: `${days.indexOf(from) + 2} / ${days.indexOf(to) + 3}`, gridRow: 1 }}
                      className={`z-10 my-2 flex h-7 min-w-0 items-center overflow-hidden px-2 text-[11px] font-semibold whitespace-nowrap hover:brightness-95 ${BAR_TONE[t.status]} ${
                        span!.from < first ? 'rounded-l-none' : 'rounded-l-md'
                      } ${span!.to > last ? 'rounded-r-none' : 'rounded-r-md'} ${late ? 'ring-2 ring-danger' : ''}`}
                    >
                      <span className="truncate">{t.title}</span>
                    </button>
                  </div>
                )
              })
            )}
          </section>

          <section aria-label="사람별 업무량" className="border-t-4 border-ground">
            <div className="grid border-b border-line" style={cols}>
              <div className="sticky left-0 z-20 flex flex-col justify-end bg-surface px-3 py-1.5">
                <span className="text-xs font-semibold text-ink-2">사람별 업무량</span>
                <span className="text-[10px] text-muted">하루 8시간 기준</span>
              </div>
              {dayHead}
            </div>
            {people.map((m) => {
              const mine = loads.get(m.userId)
              const over = days.filter((d) => (mine?.get(d) ?? 0) > DAY_CAPACITY).length
              return (
                <div key={m.userId} aria-label={personName(m)} className="grid border-b border-line last:border-b-0" style={cols}>
                  <div className="sticky left-0 z-20 flex min-w-0 flex-col justify-center bg-surface px-3 py-1.5">
                    <span className="truncate text-[13px] font-medium">
                      {personName(m)} {m.userId === meId && <span className="text-[11px] text-muted">(나)</span>}
                    </span>
                    {over > 0 && <span className="text-[11px] font-semibold text-danger">! 과부하 {over}일</span>}
                  </div>
                  {days.map((d) => {
                    const boxes = mine?.get(d) ?? 0
                    const step = loadStep(boxes)
                    const text = step ? `${personName(m)} ${Number(d.slice(5, 7))}/${Number(d.slice(8))} ${hoursText(boxes)}시간${step === 5 ? ' (과부하)' : ''}` : undefined
                    return (
                      <div key={d} className={`p-[2px] ${isWeekend(d) ? 'bg-subtle/70' : ''}`}>
                        <div
                          role={step ? 'img' : undefined}
                          aria-label={text}
                          title={text}
                          style={step ? { background: HEAT[step] } : undefined}
                          className={`flex h-8 items-center justify-center rounded-[4px] font-mono text-[10px] ${HEAT_INK[step]} ${step === 5 ? 'font-bold ring-2 ring-danger ring-inset' : ''}`}
                        >
                          {step ? `${hoursText(boxes)}${step === 5 ? '!' : ''}` : ''}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </section>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          {LEGEND.map((l, i) => (
            <span key={l} className="flex items-center gap-1">
              <span className={`inline-block h-3 w-4 rounded-[3px] ${i === 4 ? 'ring-2 ring-danger ring-inset' : ''}`} style={{ background: HEAT[i + 1] }} />
              <span className="mr-1.5">{l}</span>
            </span>
          ))}
        </span>
        <span>맡은 시간을 기간 중 평일에 고르게 나눠 계산해요 · 완료된 업무는 빼요</span>
        {undated > 0 && <span>기간이 없는 업무 {undated}개는 표시되지 않아요</span>}
      </div>

      {editing && (
        <TaskEditor
          team={team}
          meId={meId}
          task={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
          onChanged={() => void load()}
        />
      )}
    </section>
  )
}
