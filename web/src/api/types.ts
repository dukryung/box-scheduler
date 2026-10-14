export interface Block {
  id: string
  date: string
  startSlot: number
  endSlot: number
  title: string
  color: string | null
  brainDumpId: string | null
  done: boolean
  source: 'manual' | 'ai'
}

// 'carried' = copied forward to a later day (the copy is a new open item there).
export type BrainDumpStatus = 'open' | 'scheduled' | 'done' | 'dropped' | 'carried'

export interface BrainDumpItem {
  id: string
  date: string
  title: string
  estimateBoxes: number | null
  priority: number | null
  category: string | null
  status: BrainDumpStatus
  carriedFrom: string | null
}

export interface Day {
  date: string
  weekday: number
  note: string | null
  blocks: Block[]
  brainDump: BrainDumpItem[]
}

export interface CalendarItem {
  title: string
  color: string | null
  startSlot: number
  done: boolean
}

export interface CalendarDay {
  items: CalendarItem[] // earliest few blocks of the day
  total: number
  plannedBoxes: number
  doneBoxes: number
}

export interface CalendarMonth {
  month: string
  days: Record<string, CalendarDay>
}

export interface SuggestedBlock {
  taskId: string
  title: string
  startSlot: number
  endSlot: number
  reason: string
}

export interface Suggestion {
  blocks: SuggestedBlock[]
  unplaced: Array<{ taskId: string; title: string; boxes: number }>
  /** AI estimates for tasks that had none; saved when the plan is applied. */
  estimates: Array<{ taskId: string; estimateBoxes: number }>
  notes: string
}

export interface BoxCount {
  plannedBoxes: number
  doneBoxes: number
}

export interface Stats {
  from: string
  to: string
  totals: BoxCount & { blocks: number; doneBlocks: number; activeDays: number; aiBoxes: number }
  daily: Array<BoxCount & { date: string }>
  hourly: Array<BoxCount & { hour: number }>
  topTasks: Array<BoxCount & { title: string }>
  brainDump: Record<'open' | 'done' | 'carried' | 'dropped', number>
}
