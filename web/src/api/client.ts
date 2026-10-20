import type {
  AIConnection,
  AISettings,
  AIState,
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
  User,
} from './types'

export const OVERLAP_MESSAGE = '다른 블록과 시간이 겹쳐요'

/** An error answer from the API; `code` is set for errors the app acts on. */
export class ApiError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Called when the session has ended (signed out elsewhere, expired, suspended). */
let onSignedOut: () => void = () => {}
export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const signedOut = res.status === 401 || (res.status === 403 && body.error === '이용이 정지된 계정이에요')
    if (signedOut && !path.startsWith('/auth/')) onSignedOut()
    if (res.status === 409 && !path.startsWith('/auth/')) throw new ApiError(409, OVERLAP_MESSAGE)
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.code)
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

const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

export const authApi = {
  me: () => request<User>('/auth/me'),
  login: (email: string, password: string) => request<User>('/auth/login', post({ email, password })),
  signup: (email: string, password: string, name: string) => request<User>('/auth/signup', post({ email, password, name })),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  setupNeeded: () => request<{ needed: boolean }>('/auth/setup'),
  setup: (token: string, email: string, password: string, name: string) =>
    request<User>('/auth/setup', post({ token, email, password, name })),
  reset: (token: string, password: string) => request<User>('/auth/reset', post({ token, password })),
  updateMe: (name: string) => request<User>('/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) }),
  changePassword: (current: string, next: string) => request<void>('/auth/password', post({ current, new: next })),
  deleteMe: (check: { password?: string; confirm?: string }) => request<void>('/auth/me', { method: 'DELETE', body: JSON.stringify(check) }),
  providers: () => request<{ google: boolean }>('/auth/providers'),
  googleUnlink: () => request<User>('/auth/google/unlink', { method: 'POST' }),
  /** Full-page URL that starts "Google로 계속하기". */
  googleStartURL: (params: { next?: string; setup?: string; link?: boolean }) => {
    const q = new URLSearchParams()
    if (params.next) q.set('next', params.next)
    if (params.setup) q.set('setup', params.setup)
    if (params.link) q.set('link', '1')
    return `/api/auth/google/start?${q}`
  },
}

export const aiApi = {
  state: () => request<AIState>('/ai'),
  connect: (c: { kind: AIConnection['kind']; label: string; baseUrl?: string; model: string; apiKey?: string }) =>
    request<AIConnection>('/ai/connections', post(c)),
  test: (id: string) => request<{ ok: boolean; error: string }>(`/ai/connections/${id}/test`, { method: 'POST' }),
  remove: (id: string) => request<void>(`/ai/connections/${id}`, { method: 'DELETE' }),
  setSettings: (s: AISettings) => request<AISettings>('/ai/settings', { method: 'PUT', body: JSON.stringify(s) }),
  queue: () => request<{ running: number; waiting: number }>('/ai/queue'),
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
