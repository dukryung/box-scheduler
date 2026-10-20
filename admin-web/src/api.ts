// The admin server's API. Every call carries the bs_admin cookie; nothing here
// can reach the app's own API.

export type Stage = 'password' | 'enroll' | 'totp' | 'ok'

export interface Admin {
  id: string
  email: string
  name: string
  role: 'super' | 'operator'
  status: 'active' | 'disabled'
  mustChangePassword: boolean
  totpEnabled: boolean
  createdAt: string
  lastLoginAt: string | null
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
  google: boolean
  blocks: number
  items: number
  aiCalls30d: number
  /** How many own AIs (API key or local LLM) the account connected; keys are never shown. */
  aiConnections: number
}

export interface UserSession {
  id: string
  createdAt: string
  lastSeenAt: string
  expiresAt: string
  userAgent: string
}

export interface Note {
  id: number
  author: string
  body: string
  createdAt: string
}

export interface UserDetail extends User {
  sessions: UserSession[]
  aiByFeature: Record<string, number>
  activeDays30d: number
  notes: Note[]
}

export interface DayPoint {
  day: string
  signups: number
  active: number
  aiCalls: number
}

export interface Dashboard {
  users: number
  active7d: number
  signups7d: number
  suspended: number
  google: number
  aiCalls7d: number
  days: DayPoint[]
}

export interface AuditEntry {
  id: number
  actor: string
  action: string
  targetId: string | null
  target: string
  detail: string
  ip: string
  createdAt: string
}

export class ApiError extends Error {
  status: number
  stage?: Stage
  constructor(status: number, message: string, stage?: Stage) {
    super(message)
    this.status = status
    this.stage = stage
  }
}

let onSignedOut: (stage?: Stage) => void = () => {}
export const setSignedOutHandler = (fn: (stage?: Stage) => void) => {
  onSignedOut = fn
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (!path.startsWith('/auth/') && (res.status === 401 || (res.status === 403 && body.stage))) onSignedOut(body.stage)
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`, body.stage)
  }
  return (res.status === 204 ? undefined : res.json()) as Promise<T>
}

const send = (method: string, body?: unknown) => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

type SignIn = { account: Admin; stage: Stage }

export const api = {
  login: (email: string, password: string) => request<SignIn>('/auth/login', send('POST', { email, password })),
  logout: () => request<void>('/auth/logout', send('POST')),
  me: () => request<SignIn>('/auth/me'),
  changePassword: (current: string, next: string) => request<SignIn>('/auth/password', send('POST', { current, new: next })),
  totpSetup: () => request<{ secret: string; uri: string }>('/auth/totp/setup', send('POST')),
  totpVerify: (code: string) => request<SignIn>('/auth/totp/verify', send('POST', { code })),

  dashboard: () => request<Dashboard>('/dashboard'),
  users: (p: { q?: string; filter?: string; sort?: string; limit?: number; offset?: number }) =>
    request<{ users: User[]; total: number }>(`/users?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v ?? '')]))}`),
  user: (id: string) => request<UserDetail>(`/users/${id}`),
  setUserStatus: (id: string, status: User['status']) => request<User>(`/users/${id}`, send('PATCH', { status })),
  deleteUser: (id: string, password: string) => request<void>(`/users/${id}`, send('DELETE', { password })),
  revokeSessions: (id: string, session = '') => request<{ revoked: number }>(`/users/${id}/sessions/revoke`, send('POST', { session })),
  resetLink: (id: string) => request<{ url: string; expiresIn: string }>(`/users/${id}/reset-link`, send('POST')),
  addNote: (id: string, body: string) => request<Note>(`/users/${id}/notes`, send('POST', { body })),
  audit: (p: { q?: string; action?: string; target?: string; limit?: number; offset?: number }) =>
    request<{ entries: AuditEntry[]; total: number }>(`/audit?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v ?? '')]))}`),

  admins: () => request<{ admins: Admin[] }>('/admins'),
  createAdmin: (email: string, name: string, role: Admin['role'], password: string) =>
    request<{ admin: Admin; tempPassword: string }>('/admins', send('POST', { email, name, role, password })),
  updateAdmin: (id: string, patch: { role?: Admin['role']; status?: Admin['status'] }, password: string) =>
    request<Admin>(`/admins/${id}`, send('PATCH', { ...patch, password })),
  resetAdmin: (id: string, password: string) => request<{ tempPassword: string }>(`/admins/${id}/reset`, send('POST', { password })),
}
