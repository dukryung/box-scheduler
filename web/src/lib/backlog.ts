import type { BacklogItem } from '../api/types'
import { addDays, parseISODate } from './date'

export type GroupKey = 'overdue' | 'week' | 'later' | 'none' | 'done'

export const GROUP_LABELS: Record<GroupKey, string> = {
  overdue: '기한 지남',
  week: '이번 주',
  later: '나중',
  none: '마감 없음',
  done: '완료',
}

const ORDER: GroupKey[] = ['overdue', 'week', 'later', 'none', 'done']

function groupOf(item: BacklogItem, today: string): GroupKey {
  if (item.status === 'done') return 'done'
  if (!item.dueDate) return 'none'
  if (item.dueDate < today) return 'overdue'
  return item.dueDate <= addDays(today, 6) ? 'week' : 'later'
}

/** High priority first (no priority counts as normal), then earliest deadline. */
function compare(a: BacklogItem, b: BacklogItem): number {
  const pa = a.priority ?? 2
  const pb = b.priority ?? 2
  if (pa !== pb) return pa - pb
  return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')
}

/** Splits the backlog into the groups shown on screen, each sorted; empty groups are left out. */
export function groupBacklog(items: BacklogItem[], today: string): Array<{ key: GroupKey; items: BacklogItem[] }> {
  const groups = new Map<GroupKey, BacklogItem[]>()
  for (const it of items) {
    const key = groupOf(it, today)
    groups.set(key, [...(groups.get(key) ?? []), it])
  }
  return ORDER.filter((k) => groups.has(k)).map((key) => ({
    key,
    items: key === 'done' ? groups.get(key)! : [...groups.get(key)!].sort(compare),
  }))
}

/** "오늘 마감", "내일 마감", "D-3", "2일 지남", or "10/30" when it is far off. */
export function dueLabel(due: string, today: string): string {
  const days = Math.round((parseISODate(due).getTime() - parseISODate(today).getTime()) / 86_400_000)
  if (days < 0) return `${-days}일 지남`
  if (days === 0) return '오늘 마감'
  if (days === 1) return '내일 마감'
  if (days <= 14) return `D-${days}`
  const d = parseISODate(due)
  return `${d.getMonth() + 1}/${d.getDate()} 마감`
}

/** How many open items are overdue, and how many are due today or tomorrow. */
export function deadlineCounts(items: BacklogItem[], today: string) {
  const open = items.filter((it) => it.status === 'open' && it.dueDate)
  return {
    overdue: open.filter((it) => it.dueDate! < today).length,
    soon: open.filter((it) => it.dueDate! >= today && it.dueDate! <= addDays(today, 1)).length,
  }
}

/**
 * Backlog items worth offering to the AI planner for `date`: open, with time left,
 * and either high priority or due within a week (overdue counts). Mirrors the server.
 */
export function urgentBacklog(items: BacklogItem[], date: string): BacklogItem[] {
  return items.filter((it) => {
    if (it.status !== 'open' || (it.estimateBoxes !== null && it.scheduledBoxes >= it.estimateBoxes)) return false
    return it.priority === 1 || (it.dueDate !== null && it.dueDate <= addDays(date, 7))
  })
}
