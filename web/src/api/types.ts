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
  /** null for backlog items ("할 일 보관함"), which stay until done. */
  date: string | null
  title: string
  estimateBoxes: number | null
  priority: number | null
  category: string | null
  status: BrainDumpStatus
  carriedFrom: string | null
  dueDate: string | null
  note: string | null
}

/** A backlog item with its progress across every day it was scheduled on. */
export interface BacklogItem extends BrainDumpItem {
  scheduledBoxes: number
  doneBoxes: number
  /** Timetable blocks that deleting the item also deletes. */
  blockCount: number
}

export interface Day {
  date: string
  weekday: number
  note: string | null
  blocks: Block[]
  brainDump: BrainDumpItem[]
  /** Backlog or other-day items that have a block on this day. */
  linkedItems: BrainDumpItem[]
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
  /** Titles of open backlog items due on each date. */
  dues: Record<string, string[]>
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
  /** Same-length period right before `from`, for comparison. */
  previous: BoxCount
  daily: Array<BoxCount & { date: string }>
  hourly: Array<BoxCount & { hour: number }>
  topTasks: Array<BoxCount & { title: string }>
  brainDump: Record<'open' | 'done' | 'carried' | 'dropped', number>
}

/** One edit proposed by the assistant; sent back unchanged to apply it. */
export interface AssistantOp {
  kind: string
  blockId?: string
  itemId?: string
  date?: string
  startSlot?: number
  endSlot?: number
  title?: string
  done?: boolean
  color?: string
  brainDumpId?: string
  source?: string
  estimateBoxes?: number
  status?: string
}

export interface AssistantSpan {
  date: string
  startSlot: number
  endSlot: number
}

export interface AssistantChange {
  kind: 'add' | 'move' | 'edit' | 'done' | 'undone' | 'remove' | 'item-add' | 'item-edit' | 'item-remove'
  title: string
  before?: AssistantSpan
  after?: AssistantSpan
  detail?: string
}

export interface AssistantPreview {
  reply: string
  clarification: string
  ops: AssistantOp[]
  changes: AssistantChange[]
  warnings: string[]
}

export interface AssistantTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface User {
  id: string
  email: string
  name: string
  status: 'active' | 'suspended'
  isOwner: boolean
  createdAt: string
  lastLoginAt: string | null
  hasPassword: boolean
  /** A Google account is linked. */
  google: boolean
}

/** One of the account's own AIs; the key itself never comes back, only its last characters. */
export interface AIConnection {
  id: string
  kind: 'anthropic' | 'openai'
  label: string
  baseUrl: string | null
  model: string
  keyHint: string
  createdAt: string
  checkedAt: string | null
  lastError: string
}

/** Which AI each feature uses: 'server' (owner's subscription), a connection id, or '' (none). */
export interface AISettings {
  plan: string
  request: string
  tidy: string
}

export interface AIState {
  connections: AIConnection[]
  settings: AISettings
  serverAvailable: boolean
  /** The service's own AI (set up by admins): models per feature and today's use against the daily limit. */
  service: { enabled: boolean; models: Record<'plan' | 'request' | 'tidy', string>; dailyLimit: number; usedToday: number; unlimited: boolean }
  anthropicModels: string[]
  keysEnabled: boolean
}
