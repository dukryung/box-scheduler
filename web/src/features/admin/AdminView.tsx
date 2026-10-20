import { useCallback, useEffect, useState } from 'react'
import { adminApi } from '../../api/client'
import type { AdminStats, AdminUser, AuditEntry } from '../../api/types'
import { ConfirmInline } from '../../components/ConfirmInline'
import { card } from '../../components/styles'
import { todayISO } from '../../lib/date'
import { useAuth } from '../../store/authStore'
import { BottomTabs, TopBar, ViewSwitch } from '../nav/ViewSwitch'

const when = (iso: string | null) => {
  if (!iso) return '–'
  const d = new Date(iso)
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`
}

const ACTION_LABEL: Record<string, string> = {
  role: '권한 변경',
  suspend: '정지',
  restore: '정지 해제',
  delete: '삭제',
  'reset-link': '재설정 링크 발급',
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={`${card} flex flex-col gap-1 p-4`}>
      <span className="text-xs text-muted">{label}</span>
      <span className="text-2xl font-bold">{value}</span>
    </div>
  )
}

const chip = 'h-9 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-subtle disabled:opacity-40'

function UserRow({ u, me, onChanged }: { u: AdminUser; me: string; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false)
  const [link, setLink] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const locked = u.isOwner || u.id === me
  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <li className={`${card} flex flex-col gap-3 p-4`} aria-label={u.email}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[15px] font-semibold">{u.name || '이름 없음'}</span>
          <span className="truncate text-sm text-muted">{u.email}</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {u.isOwner && <span className="rounded-md bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-ink">소유자</span>}
          {u.role === 'admin' && <span className="rounded-md bg-subtle px-2 py-0.5 text-xs font-semibold text-ink-2">어드민</span>}
          {u.status === 'suspended' && <span className="rounded-md bg-danger/10 px-2 py-0.5 text-xs font-semibold text-danger">정지됨</span>}
          {!u.hasPassword && <span className="rounded-md bg-subtle px-2 py-0.5 text-xs text-muted">설정 전</span>}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-5">
        <div>
          <dt className="inline">가입 </dt>
          <dd className="inline font-mono text-ink-2">{when(u.createdAt)}</dd>
        </div>
        <div>
          <dt className="inline">마지막 로그인 </dt>
          <dd className="inline font-mono text-ink-2">{when(u.lastLoginAt)}</dd>
        </div>
        <div>
          <dt className="inline">블록 </dt>
          <dd className="inline font-mono text-ink-2">{u.blocks}</dd>
        </div>
        <div>
          <dt className="inline">할 일 </dt>
          <dd className="inline font-mono text-ink-2">{u.items}</dd>
        </div>
        <div>
          <dt className="inline">AI 30일 </dt>
          <dd className="inline font-mono text-ink-2">{u.aiCalls30d}회</dd>
        </div>
      </dl>
      {!locked && (
        <div className="flex flex-wrap gap-2">
          <button className={chip} onClick={() => act(() => adminApi.update(u.id, { role: u.role === 'admin' ? 'user' : 'admin' }))}>
            {u.role === 'admin' ? '일반 사용자로' : '어드민으로'}
          </button>
          <button className={chip} onClick={() => act(() => adminApi.update(u.id, { status: u.status === 'active' ? 'suspended' : 'active' }))}>
            {u.status === 'active' ? '정지' : '정지 해제'}
          </button>
          <button
            className={chip}
            onClick={() =>
              act(async () => {
                const r = await adminApi.resetLink(u.id)
                setLink(window.location.origin + r.path)
              })
            }
          >
            비밀번호 재설정 링크
          </button>
          <button className={`${chip} text-danger`} onClick={() => setConfirm(true)}>
            삭제
          </button>
        </div>
      )}
      {link && (
        <div className="flex flex-col gap-2 rounded-lg bg-subtle p-3 text-xs text-ink-2">
          <span>이 링크를 본인에게만 전달하세요. 24시간 동안 한 번 쓸 수 있어요.</span>
          <div className="flex gap-2">
            <input readOnly aria-label="재설정 링크" value={link} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 font-mono" />
            <button className={chip} onClick={() => void navigator.clipboard?.writeText(link)}>
              복사
            </button>
          </div>
        </div>
      )}
      {confirm && (
        <ConfirmInline
          message={`${u.email} 계정과 모든 일정·할 일을 지울까요? 되돌릴 수 없어요.`}
          onCancel={() => setConfirm(false)}
          onConfirm={() => act(() => adminApi.remove(u.id))}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </li>
  )
}

/** User management. Shows accounts and counts only; nobody's schedule is visible here. */
export function AdminView() {
  const me = useAuth((s) => s.user)
  const [q, setQ] = useState('')
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (query: string) => {
    try {
      const [u, s, a] = await Promise.all([adminApi.users(query), adminApi.stats(), adminApi.audit()])
      setUsers(u.users)
      setStats(s)
      setAudit(a.entries)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    const t = setTimeout(() => void load(q), 250)
    return () => clearTimeout(t)
  }, [q, load])

  if (me?.role !== 'admin') return <p className="p-6 text-sm text-muted">어드민만 볼 수 있어요.</p>

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <TopBar phoneTheme>
        <h1 className="flex-1 text-center text-[17px] font-semibold md:flex-none md:pl-2 md:text-left md:text-lg">사용자 관리</h1>
        <div className="ml-auto hidden md:block">
          <ViewSwitch view="other" date={todayISO()} />
        </div>
      </TopBar>

      <main className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-4 pt-3 pb-[104px] md:px-6 md:pt-6 md:pb-10">
        {stats && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Tile label="전체 사용자" value={stats.users} />
            <Tile label="최근 7일 활동" value={stats.active7d} />
            <Tile label="최근 7일 가입" value={stats.signups7d} />
            <Tile label="정지" value={stats.suspended} />
            <Tile label="AI 사용 (7일)" value={`${stats.aiCalls7d}회`} />
          </div>
        )}
        <p className="text-xs text-muted">개인정보 보호를 위해 다른 사용자의 일정·할 일 내용은 볼 수 없고 개수만 보여요.</p>

        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
          검색
          <input
            type="search"
            placeholder="이메일이나 이름"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-11 rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent md:text-sm"
          />
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {users && (
          <section aria-label="사용자 목록" className="flex flex-col gap-2">
            <h2 className="px-1 text-sm font-semibold text-ink-2">
              사용자 <span className="font-normal text-muted">{users.length}</span>
            </h2>
            <ul className="flex flex-col gap-2">
              {users.map((u) => (
                <UserRow key={u.id} u={u} me={me.id} onChanged={() => void load(q)} />
              ))}
            </ul>
            {users.length === 0 && <p className="px-1 py-6 text-center text-sm text-muted">찾는 사용자가 없어요.</p>}
          </section>
        )}

        <section aria-label="관리 기록" className={`${card} flex flex-col gap-2 p-4`}>
          <h2 className="text-sm font-semibold">관리 기록</h2>
          {audit.length === 0 ? (
            <p className="text-sm text-muted">아직 기록이 없어요.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line text-sm">
              {audit.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-x-2 py-2">
                  <span className="font-mono text-xs text-muted">{new Date(e.createdAt).toLocaleString('ko-KR')}</span>
                  <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                  <span className="text-ink-2">{e.target}</span>
                  {e.detail && <span className="text-muted">({e.detail})</span>}
                  <span className="text-muted">· {e.admin}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <BottomTabs view="other" date={todayISO()} />
    </div>
  )
}
