import { useEffect, useRef, useState } from 'react'
import { Check } from '../../components/icons'
import type { Block } from '../../api/types'
import { dayPace, type Pace } from '../../lib/dayPace'
import { hm } from '../../lib/hm'
import { SLOT_MINUTES, slotToTime } from '../../lib/slots'

function nowMinute(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function useNowMinute(): number {
  const [m, setM] = useState(nowMinute)
  useEffect(() => {
    const id = setInterval(() => setM(nowMinute()), 30_000)
    return () => clearInterval(id)
  }, [])
  return m
}

interface Props {
  blocks: Block[]
  /** Whether the day shown is today (the pace and the now card follow the clock only then). */
  isToday: boolean
  onFinish: (id: string) => void
}

/** The day's one dark panel: how much is done, what is on now, and a bar of the way so far. */
export function DaySummary({ blocks, isToday, onFinish }: Props) {
  const minute = useNowMinute()
  const now = isToday ? minute : null
  const sorted = [...blocks].sort((a, b) => a.startSlot - b.startSlot)
  const planned = sorted.reduce((n, b) => n + b.endSlot - b.startSlot, 0)
  const doneBoxes = sorted.reduce((n, b) => n + (b.done ? b.endSlot - b.startSlot : 0), 0)
  const doneCount = sorted.filter((b) => b.done).length
  const pct = planned ? Math.round((doneBoxes / planned) * 100) : 0
  const pace = dayPace(sorted, now)
  const shownPct = useCountUp(pct)

  const nowSlot = now === null ? null : Math.floor(now / SLOT_MINUTES)
  const current = nowSlot === null ? undefined : sorted.find((b) => !b.done && b.startSlot <= nowSlot && nowSlot < b.endSlot)
  const next = nowSlot === null ? undefined : sorted.find((b) => !b.done && b.startSlot > nowSlot)

  const message = !sorted.length
    ? '아직 시간표가 비어 있어요'
    : pace === 'home'
      ? isToday
        ? '오늘 할 일을 다 끝냈어요!'
        : '이날 할 일을 다 끝냈어요'
      : pace === 'walk'
        ? isToday
          ? '조금 늦어지고 있어요'
          : `${sorted.length}개 중 ${doneCount}개를 끝냈어요`
        : pace === 'run'
          ? '계획대로 가고 있어요'
          : '출발 준비 중이에요'

  // Each block is a stop on the track, at the point the day's planned time reaches when it ends.
  let reach = 0
  const stops = sorted.map((b) => {
    reach += b.endSlot - b.startSlot
    return { id: b.id, title: b.title, done: b.done, at: (reach / planned) * 100 }
  })

  return (
    <section
      aria-label={isToday ? '오늘 진행 상황' : '이날 진행 상황'}
      className="rise-in flex flex-wrap items-center gap-x-5 gap-y-2.5 rounded-[18px] bg-hero px-4 py-3 text-hero-ink shadow-[0_10px_30px_rgba(28,25,23,0.18)] md:pr-3.5 md:pl-5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 md:flex-none">
        <span className="text-[26px] leading-none font-bold tracking-tight tabular-nums md:text-[30px]" aria-label={`완료 ${pct}%`}>
          {shownPct}
          <span className="text-base text-hero-muted md:text-lg">%</span>
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-bold">{message}</span>
          <span className="truncate text-xs text-hero-muted">
            <span className="font-mono">
              {hm(doneBoxes)} / {hm(planned)}
            </span>{' '}
            · 블록 {sorted.length}개 중 {doneCount}개
          </span>
        </div>
      </div>

      {sorted.length > 0 && (
        <div className="order-last min-w-[200px] basis-full md:order-none md:basis-0 md:flex-1">
          <Track pct={pct} pace={pace} stops={stops} />
        </div>
      )}

      {current ? (
        <NowPill block={current} minute={minute} onFinish={onFinish} />
      ) : next ? (
        <div className="flex w-full min-w-0 items-center gap-2 rounded-xl bg-hero-raised px-3 py-2 text-[13px] md:w-auto md:max-w-[320px]">
          <span className="shrink-0 text-xs font-semibold text-hero-muted">다음 · {untilText(next.startSlot * SLOT_MINUTES - minute)}</span>
          <span className="truncate font-bold">{next.title}</span>
        </div>
      ) : null}
    </section>
  )
}

function untilText(minutes: number): string {
  if (minutes < 60) return `${minutes}분 뒤`
  return `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''} 뒤`
}

/** What is on now, in one line: its title, the time left, and a button to finish it. */
function NowPill({ block, minute, onFinish }: { block: Block; minute: number; onFinish: (id: string) => void }) {
  const start = block.startSlot * SLOT_MINUTES
  const end = block.endSlot * SLOT_MINUTES
  const left = Math.max(0, end - minute)
  const passed = Math.min(100, Math.max(0, ((minute - start) / (end - start)) * 100))
  return (
    <div
      title={`지금 · ${slotToTime(block.startSlot)}–${slotToTime(block.endSlot)}`}
      className="relative flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-xl bg-accent py-1.5 pr-1.5 pl-3 text-white md:w-auto md:max-w-[360px]"
    >
      <span className="live-dot h-2 w-2 shrink-0 rounded-full bg-white" />
      <span className="shrink-0 text-xs font-semibold text-white/85">지금</span>
      <span className="min-w-0 flex-1 truncate text-sm font-bold">{block.title}</span>
      <span className="shrink-0 text-xs text-white/85">{left}분 남음</span>
      <button
        onClick={() => onFinish(block.id)}
        className="h-8 shrink-0 rounded-lg bg-white px-3 text-xs font-bold text-[#9a3412] hover:bg-[#fff1e6]"
      >
        끝냈어요
      </button>
      <span
        className="absolute bottom-0 left-0 h-[3px] bg-white/70 transition-[width] duration-700"
        style={{ width: `${passed}%` }}
        role="progressbar"
        aria-label={`${left}분 남음`}
        aria-valuenow={Math.round(passed)}
      />
    </div>
  )
}

interface Stop {
  id: string
  title: string
  done: boolean
  at: number
}

/**
 * The progress bar: it fills to the share done with a stop per block. Light sweeps
 * along it while the day is on (slowly when behind), and it glows once all is done.
 */
function Track({ pct, pace, stops }: { pct: number; pace: Pace; stops: Stop[] }) {
  const home = pace === 'home'
  const moving = pace === 'run' || pace === 'walk'
  return (
    <div className="flex items-center gap-3">
      <div className="relative h-[18px] flex-1" role="progressbar" aria-label="오늘 완료" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="absolute inset-x-0 top-[3px] h-3 rounded-full bg-hero-track" />
        <div
          className={`absolute top-[3px] left-0 h-3 overflow-hidden rounded-full bg-done-bright transition-[width] duration-[900ms] ease-[cubic-bezier(.3,.9,.3,1)] ${home ? 'progress-glow' : ''}`}
          style={{ width: `${pct}%` }}
        >
          {moving && pct > 0 && (
            <span
              className={`progress-sweep absolute inset-y-0 left-0 w-2/5 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.55),transparent)] ${pace === 'walk' ? 'slow' : ''}`}
            />
          )}
        </div>
        {stops.map((s) => (
          <span
            key={s.id}
            title={s.title}
            className={`absolute top-0 h-[18px] w-[18px] -translate-x-1/2 rounded-full border-[3px] border-hero transition-colors duration-500 ${s.done ? 'done-pop bg-done-bright' : 'bg-hero-track'}`}
            style={{ left: `${s.at}%` }}
          />
        ))}
        {moving && pct > 0 && pct < 100 && (
          <span
            className="progress-head absolute top-[1px] h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-done-bright bg-white transition-[left] duration-[900ms] ease-[cubic-bezier(.3,.9,.3,1)]"
            style={{ left: `${pct}%` }}
          />
        )}
      </div>
      {home && (
        <span className="done-pop flex h-6 shrink-0 items-center gap-1 rounded-full bg-done-bright px-2.5 text-xs font-bold text-[#042f2e]">
          <Check size={12} strokeWidth={3.2} />
          완주
        </span>
      )}
    </div>
  )
}

/** Counts up (or down) to `value` over a moment, so a change in the share done is seen. */
function useCountUp(value: number): number {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value
      setShown(value)
      return
    }
    const began = performance.now()
    let frame = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - began) / 700)
      const v = Math.round(start + (value - start) * (1 - (1 - k) ** 3))
      from.current = v
      setShown(v)
      if (k < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value])
  return shown
}
