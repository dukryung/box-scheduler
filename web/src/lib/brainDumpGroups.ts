import type { Block, BrainDumpItem } from '../api/types'

export interface Row {
  item: BrainDumpItem
  /** This day's blocks for the item, earliest first. */
  sessions: Block[]
  /** Set when the item lives elsewhere (backlog or another day) but has a block today. */
  linked?: 'backlog' | 'other-day'
}

export interface BrainDumpGroups {
  /** Open items with no time on this day yet ("미배정"). */
  unscheduled: Row[]
  /** Open items with at least one block today, including linked ones. */
  scheduled: Row[]
  done: Row[]
  /** Carried to another day or dropped. */
  closed: Row[]
}

/** Splits the day's brain dump by whether each item made it onto the timetable. */
export function groupBrainDump(items: BrainDumpItem[], linked: BrainDumpItem[], blocks: Block[]): BrainDumpGroups {
  const sessionsOf = (id: string) => blocks.filter((b) => b.brainDumpId === id).sort((a, b) => a.startSlot - b.startSlot)
  const groups: BrainDumpGroups = { unscheduled: [], scheduled: [], done: [], closed: [] }

  const place = (row: Row) => {
    const { status } = row.item
    if (status === 'done') groups.done.push(row)
    else if (status === 'carried' || status === 'dropped') groups.closed.push(row)
    else if (row.sessions.length === 0) groups.unscheduled.push(row)
    else groups.scheduled.push(row)
  }
  for (const item of items) place({ item, sessions: sessionsOf(item.id) })
  for (const item of linked) place({ item, sessions: sessionsOf(item.id), linked: item.date === null ? 'backlog' : 'other-day' })

  // Scheduled rows read top to bottom like the timetable.
  groups.scheduled.sort((a, b) => a.sessions[0].startSlot - b.sessions[0].startSlot)
  return groups
}
