import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import { api } from '../../api/client'
import type { Stats } from '../../api/types'
import { WEEKDAYS, parseISODate, todayISO } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { RANGE_PRESETS, isRangePreset, presetRange, type RangePreset } from '../../lib/statsRange'
import { ViewSwitch } from '../nav/ViewSwitch'
import { BarList, Card, ColumnChart, Legend, TableView, type ColumnDatum } from './charts'

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

function hourlyData(stats: Stats): ColumnDatum[] {
  return stats.hourly.map((h) => ({
    key: String(h.hour),
    tick: h.hour % 3 === 0 ? `${h.hour}시` : '',
    title: `${h.hour}:00–${h.hour + 1}:00`,
    planned: h.plannedBoxes,
    done: h.doneBoxes,
  }))
}

function Tile({ label, value, detail, className = '' }: { label: string; value: string; detail?: string; className?: string }) {
  return (
    <div className={`rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 ${className}`}>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {detail && <div className="mt-0.5 text-xs text-zinc-500">{detail}</div>}
    </div>
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
  const rate = t && t.plannedBoxes > 0 ? Math.round((t.doneBoxes / t.plannedBoxes) * 100) : null
  const days = stats?.daily.length ?? 0
  const bd = stats?.brainDump

  return (
    <div className="flex min-h-dvh flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <h1 className="text-lg font-semibold">통계</h1>
        <div className="ml-auto">
          <ViewSwitch view="stats" date={todayISO()} />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4">
        <div role="radiogroup" aria-label="기간" className="flex flex-wrap gap-1">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.id}
              role="radio"
              aria-checked={p.id === preset}
              onClick={() => setParams({ range: p.id })}
              className={`rounded-md px-3 py-1 text-sm ${p.id === preset ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'}`}
            >
              {p.label}
            </button>
          ))}
          <span className="ml-2 self-center text-xs text-zinc-500 tabular-nums">
            {from} – {to}
          </span>
        </div>

        {error && <p className="text-sm text-red-600">불러오지 못했어요: {error}</p>}

        {stats && t && bd && (
          <div className={`flex flex-col gap-4 transition-opacity ${stale ? 'opacity-50' : ''}`} aria-busy={stale}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
              <div className="col-span-2 rounded-xl border border-zinc-200 p-4 md:col-span-1 dark:border-zinc-800">
                <div className="text-xs text-zinc-500">완료율</div>
                <div className="mt-1 text-5xl font-semibold" data-testid="completion-rate">
                  {rate === null ? '–' : `${rate}%`}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  계획한 {formatDuration(t.plannedBoxes)} 중 {formatDuration(t.doneBoxes)} 완료
                </div>
              </div>
              <Tile label="계획한 시간" value={formatDuration(t.plannedBoxes)} detail={`블록 ${t.blocks}개`} />
              <Tile label="일정 있는 날" value={`${t.activeDays}일`} detail={`${days}일 중`} />
              <Tile
                label="Brain Dump"
                value={`${bd.done}개 완료`}
                detail={`넘김 ${bd.carried} · 남음 ${bd.open}`}
                className="col-span-2 md:col-span-1"
              />
            </div>

            {t.blocks === 0 ? (
              <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
                이 기간에는 시간표에 넣은 블록이 없어요.
              </p>
            ) : (
              <>
                <Card title="날짜별 계획과 완료" subtitle="하루에 계획한 시간 중 얼마나 끝냈는지" aside={<Legend />}>
                  <ColumnChart data={dailyData(stats)} label="날짜별 계획 시간과 완료 시간" />
                  <TableView
                    head="날짜"
                    rows={stats.daily.map((d) => ({ key: d.date, label: dayLabel(d.date), planned: d.plannedBoxes, done: d.doneBoxes }))}
                  />
                </Card>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Card title="시간대별 분포" subtitle="하루 중 언제 일을 계획하고 끝내는지" aside={<Legend />}>
                    <ColumnChart data={hourlyData(stats)} height={180} label="시간대별 계획 시간과 완료 시간" />
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
                      <p className="mt-3 text-xs text-zinc-500">
                        계획한 시간 중 {Math.round((t.aiBoxes / t.plannedBoxes) * 100)}%는 AI 제안으로 만들었어요.
                      </p>
                    )}
                  </Card>
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
