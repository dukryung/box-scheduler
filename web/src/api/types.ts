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

export interface BrainDumpItem {
  id: string
  date: string
  title: string
  estimateBoxes: number | null
  priority: number | null
  category: string | null
  status: 'open' | 'scheduled' | 'done' | 'dropped'
  carriedFrom: string | null
}

export interface Day {
  date: string
  weekday: number
  note: string | null
  blocks: Block[]
  brainDump: BrainDumpItem[]
}
