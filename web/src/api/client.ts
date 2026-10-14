import type { Day } from './types'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>
}

export const api = {
  getDay: (date: string) => request<Day>(`/days/${date}`),
}
