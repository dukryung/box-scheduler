import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api } from '../../api/client'
import type { Stats } from '../../api/types'
import { card } from '../../components/styles'
import { WEEKDAYS, parseISODate, todayISO } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { RANGE_PRESETS, isRangePreset, presetRange, type RangePreset } from '../../lib/statsRange'
import { BottomTabs, TopBar, ViewSwitch } from '../nav/ViewSwitch'
import { BarList, Card, ColumnChart, HourStrip, Legend, TableView, type ColumnDatum } from './charts'

function dayLabel(iso: string) {
  const d = parseISODate(iso)
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})`
}

function dailyData(stats: Stats): ColumnDatum[] {
  const every = stats.daily.length <= 10 ? 1 : 5
  return stats.daily.map((d, i) => {
    const date = parseISODate(d.date)
    return {
      key: d.date,
      tick: i % every === 0 ? (every === 1 ? `${date.getDate()}일` : `${date.getMonth() + 1}/${date.getDate()}`) : '',
      title: dayLabel(d.date),
      planned: d.plannedBoxes,
      done: d.doneBoxes,
    }
  })
}

const pct = (done: number, planned: number) => (planned > 0 ? Math.round((done / planned) * 100) : null)

/** "오전 9–11시에 가장 많이 계획하고, 이 시간대 완료율은 84%예요" from the busiest two hours. */
function busiestHours(stats: Stats): string | null {
  let best = -1
  let bestPlanned = 0
  for (let h = 0; h < 23; h++) {
    const planned = stats.hourly[h].plannedBoxes + stats.hourly[h + 1].plannedBoxes
    if (planned > bestPlanned) {
      best = h
      bestPlanned = planned
    }
  }
  if (best < 0) return null
  const done = stats.hourly[best].doneBoxes + stats.hourly[best + 1].doneBoxes
  const part = best < 12 ? '오전' : '오후'
  const from = best <= 12 ? best : best - 12
  return `${part} ${from}–${from + 2}시에 가장 많이 계획하고, 이 시간대 완료율은 ${pct(done, bestPlanned)}%예요.`
}

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <section className={`${card} flex flex-col gap-1 p-4 md:p-5`}>
      <span className="text-xs text-muted md:text-[13px]">{label}</span>
      <span className="text-2xl font-bold md:text-[28px]">{value}</span>
      {detail && <span className="text-[11px] text-muted md:text-xs">{detail}</span>}
    </section>
  )
}

export function StatsView() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('range')
  const preset: RangePreset = isRangePreset(raw) ? raw : '7d'
  const { from, to } = presetRange(preset, todayISO())

  const [stats, setStats] = useState<Stats | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api.getStats(from, to).then(
      (res) => {
        if (cancelled) return
        setStats(res)
        setError(null)
      },
      (e: Error) => !cancelled && setError(e.message),
    )
    return () => {
      cancelled = true
    }
  }, [from, to])

  // While a new range loads, keep the previous charts on screen, dimmed.
  const stale = stats !== null && (stats.from !== from || stats.to !== to)
  const t = stats?.totals
  const rate = t ? pct(t.doneBoxes, t.plannedBoxes) : null
  const prevRate = stats ? pct(stats.previous.doneBoxes, stats.previous.plannedBoxes) : null
  const delta = rate !== null && prevRate !== null ? rate - prevRate : null
  const days = stats?.daily.length ?? 0
  const bd = stats?.brainDump
  const insight = stats ? busiestHours(stats) : null

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <TopBar>
        <h1 className="flex-1 text-center text-[17px] font-semibold md:flex-none md:pl-2 md:text-left md:text-lg">통계</h1>
        <div className="ml-auto hidden md:block">
          <ViewSwitch view="stats" date={todayISO()} />
        </div>
      </TopBar>

      <main className="mx-auto flex w-full max-w-[1280px] flex-col gap-3 px-4 pt-3 pb-[104px] md:gap-4 md:px-6 md:pt-5 md:pb-8">
        <div className="flex flex-wrap items-center gap-3">
          <div role="radiogroup" aria-label="기간" className="grid w-full grid-cols-4 rounded-[10px] bg-subtle p-[3px] md:flex md:w-auto md:border md:border-line md:bg-surface">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.id}
                role="radio"
                aria-checked={p.id === preset}
                onClick={() => setParams({ range: p.id })}
                className={`h-9 rounded-lg px-3.5 text-[13px] ${
                  p.id === preset ? 'bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(21,23,28,0.08)] md:bg-ink md:text-surface' : 'text-muted hover:text-ink'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <span className="hidden font-mono text-xs text-muted md:inline">
            {from} – {to}
          </span>
        </div>

        {error && <p className="text-sm text-danger">불러오지 못했어요: {error}</p>}

        {stats && t && bd && (
          <div className={`flex flex-col gap-3 transition-opacity md:gap-4 ${stale ? 'opacity-50' : ''}`} aria-busy={stale}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-[2fr_1fr_1fr]">
              <section className={`${card} col-span-2 flex flex-col gap-2.5 p-[18px] md:col-span-1 md:p-5`}>
                <span className="text-[13px] text-muted">완료율</span>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[52px] leading-none font-bold tracking-tight md:text-[56px]" data-testid="completion-rate">
                    {rate === null ? '–' : `${rate}%`}
                  </span>
                  {delta !== null && (
                    <span className={`text-xs font-semibold md:text-[13px] ${delta > 0 ? 'text-good' : delta < 0 ? 'text-danger' : 'text-muted'}`}>
                      이전 {days}일보다 {delta === 0 ? '같아요' : `${Math.abs(delta)}%p ${delta > 0 ? '높아요' : '낮아요'}`}
                    </span>
                  )}
                </div>
                <div className="h-2 rounded-full bg-[#cde2fb] dark:bg-[#184f95]">
                  <div className="h-2 rounded-full bg-[var(--viz-done)]" style={{ width: `${rate ?? 0}%` }} />
                </div>
                <span className="text-[13px] text-muted">
                  계획한 {formatDuration(t.plannedBoxes)} 중 {formatDuration(t.doneBoxes)} 완료 · 블록 {t.blocks}개
                </span>
              </section>
              <Tile
                label="일정 있는 날"
                value={`${t.activeDays}일`}
                detail={`${days}일 중${t.activeDays ? ` · 하루 평균 ${formatDuration(Math.round(t.plannedBoxes / t.activeDays))}` : ''}`}
              />
              <Tile label="Brain Dump" value={`${bd.done}개 완료`} detail={`넘김 ${bd.carried} · 남음 ${bd.open}`} />
            </div>

            {t.blocks === 0 ? (
              <p className="rounded-2xl border border-dashed border-line-strong px-4 py-10 text-center text-sm text-muted">
                이 기간에는 시간표에 넣은 블록이 없어요.
              </p>
            ) : (
              <>
                <Card title="날짜별 계획과 완료" subtitle="막대를 가리키면 그날의 시간이 보여요" aside={<Legend />}>
                  <ColumnChart data={dailyData(stats)} label="날짜별 계획 시간과 완료 시간" />
                  <TableView
                    head="날짜"
                    rows={stats.daily.map((d) => ({ key: d.date, label: dayLabel(d.date), planned: d.plannedBoxes, done: d.doneBoxes }))}
                  />
                </Card>

                <div className="grid gap-3 md:gap-4 lg:grid-cols-2">
                  <Card title="언제 일하나요" subtitle="시간대별로 계획한 시간, 진할수록 많아요">
                    <HourStrip hours={stats.hourly.map((h) => ({ hour: h.hour, planned: h.plannedBoxes, done: h.doneBoxes }))} />
                    {insight && <p className="mt-4 rounded-xl bg-ground px-3.5 py-3 text-[13px] leading-relaxed text-ink-2">{insight}</p>}
                    <TableView
                      head="시간대"
                      rows={stats.hourly
                        .filter((h) => h.plannedBoxes > 0)
                        .map((h) => ({ key: String(h.hour), label: `${h.hour}시`, planned: h.plannedBoxes, done: h.doneBoxes }))}
                    />
                  </Card>

                  <Card title="시간을 가장 많이 쓴 일" subtitle={`상위 ${stats.topTasks.length}개`} aside={<Legend />}>
                    <BarList data={stats.topTasks.map((x) => ({ title: x.title, planned: x.plannedBoxes, done: x.doneBoxes }))} />
                    {t.aiBoxes > 0 && (
                      <p className="mt-4 text-xs text-muted">계획한 시간 중 {Math.round((t.aiBoxes / t.plannedBoxes) * 100)}%는 AI 제안으로 만들었어요.</p>
                    )}
                  </Card>
                </div>
              </>
            )}
          </div>
        )}
      </main>

      <BottomTabs view="stats" date={todayISO()} />
    </div>
  )
}
