import type {
  AssistantOp,
  AssistantPreview,
  AssistantTurn,
  BacklogItem,
  Block,
  BrainDumpItem,
  CalendarMonth,
  Day,
  Stats,
  SuggestedBlock,
  Suggestion,
} from './types'

export const OVERLAP_MESSAGE = '다른 블록과 시간이 겹쳐요'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    if (res.status === 409) throw new Error(OVERLAP_MESSAGE)
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>
}

export type NewBlock = Pick<Block, 'date' | 'startSlot' | 'endSlot' | 'title'> &
  Partial<Pick<Block, 'color' | 'brainDumpId'>>

export type BlockPatch = Partial<Pick<Block, 'date' | 'startSlot' | 'endSlot' | 'title' | 'color' | 'done'>>

export type NewBrainDumpItem = { date: string; title: string } & Partial<Pick<BrainDumpItem, 'estimateBoxes' | 'dueDate' | 'priority'>>

export type BrainDumpPatch = Partial<Pick<BrainDumpItem, 'title' | 'estimateBoxes' | 'status' | 'priority'>> & {
  /** '' clears the value. */
  dueDate?: string
  note?: string
}

export interface NewTask {
  title: string
  estimateBoxes?: number | null
  dueDate?: string | null
  priority?: number | null
  note?: string | null
}

export const api = {
  getDay: (date: string) => request<Day>(`/days/${date}`),
  getCalendar: (month: string) => request<CalendarMonth>(`/calendar?month=${month}`),
  getStats: (from: string, to: string) => request<Stats>(`/stats?from=${from}&to=${to}`),

  createBlock: (b: NewBlock) => request<Block>('/blocks', { method: 'POST', body: JSON.stringify(b) }),
  updateBlock: (id: string, p: BlockPatch) =>
    request<Block>(`/blocks/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  deleteBlock: (id: string) => request<void>(`/blocks/${id}`, { method: 'DELETE' }),

  createBrainDump: (it: NewBrainDumpItem) =>
    request<BrainDumpItem>('/brain-dump', { method: 'POST', body: JSON.stringify(it) }),
  updateBrainDump: (id: string, p: BrainDumpPatch) =>
    request<BrainDumpItem>(`/brain-dump/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  deleteBrainDump: (id: string) => request<void>(`/brain-dump/${id}`, { method: 'DELETE' }),
  listTasks: () => request<{ items: BacklogItem[] }>('/tasks'),
  createTask: (t: NewTask) => request<BacklogItem>('/tasks', { method: 'POST', body: JSON.stringify(t) }),
  /** Puts an item on a day, or into the backlog with null. */
  moveBrainDump: (id: string, date: string | null) =>
    request<BrainDumpItem>(`/brain-dump/${id}/move`, { method: 'POST', body: JSON.stringify({ date }) }),
  carryOver: (from: string, to: string) =>
    request<BrainDumpItem[]>(`/days/${from}/carry-over`, { method: 'POST', body: JSON.stringify({ to }) }),

  aiSuggest: (date: string, fromSlot: number, toSlot: number, includeBacklog: boolean, signal?: AbortSignal) =>
    request<Suggestion>(`/days/${date}/ai-suggest`, {
      method: 'POST',
      body: JSON.stringify({ fromSlot, toSlot, includeBacklog }),
      signal,
    }),
  assistantPreview: (
    body: { message: string; history: AssistantTurn[]; viewDate: string; today: string; now: string },
    signal?: AbortSignal,
  ) => request<AssistantPreview>('/assistant/preview', { method: 'POST', body: JSON.stringify(body), signal }),
  /** Rewrites a dictated transcript into a short request; nothing is sent or saved. */
  assistantTidy: (text: string, signal?: AbortSignal) =>
    request<{ text: string }>('/assistant/tidy', { method: 'POST', body: JSON.stringify({ text }), signal }),
  assistantApply: (ops: AssistantOp[]) =>
    request<{ undo: AssistantOp[] }>('/assistant/apply', { method: 'POST', body: JSON.stringify({ ops }) }),
  aiApply: (date: string, blocks: SuggestedBlock[], estimates: Suggestion['estimates']) =>
    request<Block[]>(`/days/${date}/ai-apply`, {
      method: 'POST',
      body: JSON.stringify({
        blocks: blocks.map(({ taskId, title, startSlot, endSlot }) => ({ taskId, title, startSlot, endSlot })),
        estimates,
      }),
    }),
}
