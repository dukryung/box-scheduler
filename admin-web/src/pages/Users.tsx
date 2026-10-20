import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { api, type User } from '../api'
import { ago, dateText, field } from '../format'
import { Badge, Card, ErrorText, PageHeader, Pager } from '../ui'

const FILTERS = [
  ['all', '전체'],
  ['active', '사용 중'],
  ['suspended', '정지'],
  ['google', 'Google 연결'],
  ['password', '비밀번호 있음'],
  ['owner', '소유자'],
] as const

const SORTS = [
  ['created', '가입 최신순'],
  ['login', '최근 로그인순'],
  ['ai', 'AI 사용 많은 순'],
  ['email', '이메일순'],
] as const

const LIMIT = 50

export function UserBadges({ u }: { u: User }) {
  return (
    <span className="flex flex-wrap gap-1">
      {u.isOwner && <Badge tone="accent">소유자</Badge>}
      {u.status === 'suspended' && <Badge tone="danger">정지</Badge>}
      {u.google && <Badge>Google</Badge>}
      {u.hasPassword && <Badge>비밀번호</Badge>}
    </span>
  )
}

/** App accounts: search, filter and sort; counts only, never schedule contents. */
export function Users() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const filter = params.get('filter') ?? 'all'
  const sort = params.get('sort') ?? 'created'
  const offset = Number(params.get('offset') ?? 0)
  const [text, setText] = useState(q)
  const [data, setData] = useState<{ users: User[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v && v !== 'all' && !(k === 'sort' && v === 'created') && v !== '0') next.set(k, v)
      else next.delete(k)
    }
    setParams(next, { replace: true })
  }

  useEffect(() => {
    const t = setTimeout(() => text !== q && update({ q: text, offset: '0' }), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text])

  useEffect(() => {
    let cancelled = false
    api.users({ q, filter, sort, limit: LIMIT, offset }).then(
      (d) => !cancelled && (setData(d), setError(null)),
      (e: Error) => !cancelled && setError(e.message),
    )
    return () => {
      cancelled = true
    }
  }, [q, filter, sort, offset])

  return (
    <>
      <PageHeader title="사용자">{data && <span className="text-sm text-muted">총 {data.total}명</span>}</PageHeader>
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-56 flex-1">
          <span className="sr-only">검색</span>
          <input type="search" placeholder="이메일이나 이름으로 검색" className={field} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <label>
          <span className="sr-only">정렬</span>
          <select className={`${field} w-auto`} value={sort} onChange={(e) => update({ sort: e.target.value, offset: '0' })}>
            {SORTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div role="radiogroup" aria-label="필터" className="flex flex-wrap gap-1.5">
        {FILTERS.map(([v, l]) => (
          <button
            key={v}
            role="radio"
            aria-checked={filter === v}
            onClick={() => update({ filter: v, offset: '0' })}
            className={`h-8 rounded-full border px-3 text-xs font-medium ${filter === v ? 'border-ink bg-ink text-surface' : 'border-line-strong text-ink-2 hover:bg-subtle'}`}
          >
            {l}
          </button>
        ))}
      </div>
      <ErrorText error={error} />
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">사용자</th>
                <th className="px-3 py-2.5 font-medium">상태</th>
                <th className="px-3 py-2.5 font-medium">가입</th>
                <th className="px-3 py-2.5 font-medium">마지막 로그인</th>
                <th className="px-3 py-2.5 text-right font-medium">블록</th>
                <th className="px-3 py-2.5 text-right font-medium">할 일</th>
                <th className="px-4 py-2.5 text-right font-medium">AI 30일</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data?.users.map((u) => (
                <tr key={u.id} className="hover:bg-subtle/50">
                  <td className="px-4 py-2.5">
                    <Link to={`/users/${u.id}`} className="flex flex-col">
                      <span className="font-medium hover:underline">{u.name || '이름 없음'}</span>
                      <span className="text-xs text-muted">{u.email}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <UserBadges u={u} />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-ink-2">{dateText(u.createdAt)}</td>
                  <td className="px-3 py-2.5 text-xs text-ink-2">{ago(u.lastLoginAt)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">{u.blocks}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-xs">{u.items}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">{u.aiCalls30d}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.users.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted">조건에 맞는 사용자가 없어요.</p>}
        {data && <Pager total={data.total} limit={LIMIT} offset={offset} onPage={(o) => update({ offset: String(o) })} />}
      </Card>
    </>
  )
}
