import type { BacklogItem } from '../../api/types'
import { Flag } from '../../components/icons'
import { dueLabel } from '../../lib/backlog'
import { formatDuration } from '../../lib/slots'

/** Deadline chip; red once it is today or past, so urgency never relies on color alone (the text says it). */
export function DueBadge({ due, today }: { due: string; today: string }) {
  const urgent = due <= today
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium ${
        urgent ? 'bg-danger/10 text-danger' : 'bg-subtle text-ink-2'
      }`}
      title={`마감 ${due}`}
    >
      {dueLabel(due, today)}
    </span>
  )
}

export function PriorityBadge({ priority }: { priority: number | null }) {
  if (priority === 1)
    return (
      <span className="inline-flex items-center gap-0.5 rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] font-semibold text-danger">
        <Flag size={11} />
        중요
      </span>
    )
  if (priority === 3) return <span className="rounded-md bg-subtle px-1.5 py-0.5 text-[11px] text-muted">낮음</span>
  return null
}

/** Scheduled and done time across days, against the estimate when there is one. */
export function Progress({ item }: { item: BacklogItem }) {
  if (item.scheduledBoxes === 0) return null
  const goal = item.estimateBoxes ?? item.scheduledBoxes
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className="relative h-1 w-12 rounded-full bg-line" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent-bright/35" style={{ width: `${Math.min(100, (item.scheduledBoxes / goal) * 100)}%` }} />
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent-bright" style={{ width: `${Math.min(100, (item.doneBoxes / goal) * 100)}%` }} />
      </span>
      배정 {formatDuration(item.scheduledBoxes)}
      {item.doneBoxes > 0 && ` · 완료 ${formatDuration(item.doneBoxes)}`}
    </span>
  )
}
