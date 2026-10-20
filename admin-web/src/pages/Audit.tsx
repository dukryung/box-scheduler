import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api, type AuditEntry } from '../api'
import { ACTION_LABEL, dateTimeText, field } from '../format'
import { Card, ErrorText, PageHeader, Pager } from '../ui'

const LIMIT = 50
const DANGER = new Set(['login-failed', 'totp-failed', 'user-delete', 'user-suspend', 'admin-reset', 'admin-disable'])

export function Audit() {
  const [q, setQ] = useState('')
  const [action, setAction] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ entries: AuditEntry[]; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(
      () =>
        api.audit({ q, action, limit: LIMIT, offset }).then(
          (d) => (setData(d), setError(null)),
          (e: Error) => setError(e.message),
        ),
      200,
    )
    return () => clearTimeout(t)
  }, [q, action, offset])

  return (
    <>
      <PageHeader title="관리 기록">{data && <span className="text-sm text-muted">총 {data.total}건</span>}</PageHeader>
      <div className="flex flex-wrap gap-2">
        <label className="min-w-56 flex-1">
          <span className="sr-only">검색</span>
          <input
            type="search"
            className={field}
            placeholder="관리자나 대상 이메일"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setOffset(0)
            }}
          />
        </label>
        <label>
          <span className="sr-only">종류</span>
          <select
            className={`${field} w-auto`}
            value={action}
            onChange={(e) => {
              setAction(e.target.value)
              setOffset(0)
            }}
          >
            <option value="">모든 종류</option>
            {Object.entries(ACTION_LABEL)
              .filter(([k]) => k.includes('-') || k === 'login')
              .map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
          </select>
        </label>
      </div>
      <ErrorText error={error} />
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-line text-xs text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">시각</th>
                <th className="px-3 py-2.5 font-medium">관리자</th>
                <th className="px-3 py-2.5 font-medium">한 일</th>
                <th className="px-3 py-2.5 font-medium">대상</th>
                <th className="px-3 py-2.5 font-medium">내용</th>
                <th className="px-4 py-2.5 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data?.entries.map((e) => (
                <tr key={e.id}>
                  <td className="px-4 py-2 font-mono text-xs whitespace-nowrap text-muted">{dateTimeText(e.createdAt)}</td>
                  <td className="px-3 py-2 text-xs">{e.actor}</td>
                  <td className={`px-3 py-2 font-medium whitespace-nowrap ${DANGER.has(e.action) ? 'text-danger' : ''}`}>{ACTION_LABEL[e.action] ?? e.action}</td>
                  <td className="px-3 py-2 text-xs">
                    {e.targetId && e.action.startsWith('user-') ? (
                      <Link to={`/users/${e.targetId}`} className="hover:underline">
                        {e.target}
                      </Link>
                    ) : (
                      e.target
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">{e.detail}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted">{e.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data?.entries.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted">기록이 없어요.</p>}
        {data && <Pager total={data.total} limit={LIMIT} offset={offset} onPage={setOffset} />}
      </Card>
    </>
  )
}
