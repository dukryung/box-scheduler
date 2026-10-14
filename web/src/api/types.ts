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
