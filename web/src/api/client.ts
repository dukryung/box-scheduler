import type { Block, Day } from './types'

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

export const api = {
  getDay: (date: string) => request<Day>(`/days/${date}`),

  createBlock: (b: NewBlock) => request<Block>('/blocks', { method: 'POST', body: JSON.stringify(b) }),
  updateBlock: (id: string, p: BlockPatch) =>
    request<Block>(`/blocks/${id}`, { method: 'PATCH', body: JSON.stringify(p) }),
  deleteBlock: (id: string) => request<void>(`/blocks/${id}`, { method: 'DELETE' }),
}
