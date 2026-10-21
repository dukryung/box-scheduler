import type { TeamTask, TeamTaskStatus } from '../api/types'
import { addDays, parseISODate } from './date'

export const STATUSES: { key: TeamTaskStatus; label: string }[] = [
  { key: 'todo', label: '할 일' },
  { key: 'doing', label: '진행 중' },
  { key: 'done', label: '완료' },
]
export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.key, s.label])) as Record<TeamTaskStatus, string>
export const STATUS_TONE: Record<TeamTaskStatus, string> = {
  todo: 'bg-subtle text-ink-2',
  doing: 'bg-accent-soft text-accent-ink',
  done: 'bg-good/10 text-good',
}

/** A working day is 8 hours (09–18, lunch out) = 48 boxes. */
export const DAY_CAPACITY = 48

const short = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`

export function periodText(t: Pick<TeamTask, 'startDate' | 'dueDate'>): string {
  if (t.startDate && t.dueDate) return t.startDate === t.dueDate ? short(t.dueDate) : `${short(t.startDate)} ~ ${short(t.dueDate)}`
  if (t.dueDate) return `~ ${short(t.dueDate)}`
  if (t.startDate) return `${short(t.startDate)} ~`
  return ''
}

export const isWeekend = (iso: string) => {
  const d = parseISODate(iso).getDay()
  return d === 0 || d === 6
}

/** Every date of a month ("2026-10"). */
export function monthDays(month: string): string[] {
  const days: string[] = []
  for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) days.push(d)
  return days
}

/** The span a task is drawn over: start..due, or the one date it has. Null without dates. */
export function taskSpan(t: Pick<TeamTask, 'startDate' | 'dueDate'>): { from: string; to: string } | null {
  const from = t.startDate ?? t.dueDate
  const to = t.dueDate ?? t.startDate
  return from && to ? { from, to } : null
}

/**
 * Each person's planned work per day, in boxes. A share is spread evenly over the
 * weekdays of the task's period (all its days when it has no weekday). Without a
 * start date the period runs from today (or the due date, if already past).
 * Without a share of their own, assignees split the estimate. Done tasks and
 * tasks without a due date don't count.
 */
export function dailyLoad(tasks: TeamTask[], today: string): Map<string, Map<string, number>> {
  const load = new Map<string, Map<string, number>>()
  for (const t of tasks) {
    if (t.status === 'done' || !t.dueDate || !t.assignees.length) continue
    let from = t.startDate ?? (today < t.dueDate ? today : t.dueDate)
    if (from > t.dueDate) from = t.dueDate
    const all: string[] = []
    for (let d = from; d <= t.dueDate; d = addDays(d, 1)) all.push(d)
    const days = all.filter((d) => !isWeekend(d))
    const spread = days.length ? days : all
    for (const a of t.assignees) {
      const boxes = a.boxes ?? (t.estimateBoxes ? t.estimateBoxes / t.assignees.length : 0)
      if (!boxes) continue
      const per = boxes / spread.length
      const mine = load.get(a.userId) ?? new Map<string, number>()
      for (const d of spread) mine.set(d, (mine.get(d) ?? 0) + per)
      load.set(a.userId, mine)
    }
  }
  return load
}

/** Heat step for a day's load: 0 = nothing, 1..4 = up to 2/4/6/8 hours, 5 = over 8 hours. */
export function loadStep(boxes: number): number {
  if (boxes <= 0) return 0
  if (boxes > DAY_CAPACITY) return 5
  return Math.min(4, Math.ceil(boxes / 12))
}

/** Hours for display, one decimal at most. */
export const hoursText = (boxes: number) => `${Math.round((boxes / 6) * 10) / 10}`
