import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { api, type AuditEntry, type UserDetail as Detail } from '../api'
import { ACTION_LABEL, AI_FEATURE, ago, btn, dateText, dateTimeText, deviceText, field } from '../format'
import { Card, CopyOnce, ErrorText, PageHeader, Reauth } from '../ui'
import { UserBadges } from './Users'

export function UserDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [u, setU] = useState<Detail | null>(null)
  const [history, setHistory] = useState<AuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const load = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([api.user(id), api.audit({ target: id, limit: 20 })])
      setU(d)
      setHistory(a.entries)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [id])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!u) return <ErrorText error={error} />
  const locked = u.isOwner

  return (
    <>
      <Link to="/users" className="text-sm text-muted hover:text-ink">
        ← 사용자 목록
      </Link>
      <PageHeader title={u.name || u.email}>
        <UserBadges u={u} />
      </PageHeader>
      <ErrorText error={error} />

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          <Card title="계정">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 text-sm sm:grid-cols-3">
              {[
                ['이메일', u.email],
                ['가입', dateText(u.createdAt)],
                ['마지막 로그인', dateTimeText(u.lastLoginAt)],
                ['로그인 방법', [u.hasPassword && '이메일+비밀번호', u.google && 'Google'].filter(Boolean).join(', ') || '–'],
                ['최근 30일 사용', `${u.activeDays30d}일`],
                ['블록 · 할 일', `${u.blocks} · ${u.items}`],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5">
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd className="break-all">{v}</dd>
                </div>
              ))}
            </dl>
            <p className="border-t border-line px-4 py-2.5 text-xs text-muted">일정·할 일의 내용은 관리자에게 보이지 않아요. 개수만 보여요.</p>
          </Card>

          <Card
            title={`로그인된 기기 ${u.sessions.length}`}
            aside={
              u.sessions.length > 0 && (
                <button className={btn.secondary} onClick={() => act(() => api.revokeSessions(u.id))}>
                  모든 기기 로그아웃
                </button>
              )
            }
          >
            {u.sessions.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted">로그인된 기기가 없어요.</p>
            ) : (
              <ul className="divide-y divide-line">
                {u.sessions.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                    <span className="font-medium">{deviceText(s.userAgent)}</span>
                    <span className="text-xs text-muted">마지막 사용 {ago(s.lastSeenAt)}</span>
                    <span className="text-xs text-muted">로그인 {dateTimeText(s.createdAt)}</span>
                    <button className={`${btn.ghost} ml-auto`} onClick={() => act(() => api.revokeSessions(u.id, s.id))}>
                      로그아웃
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="운영 메모">
            <form
              className="flex gap-2 border-b border-line px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault()
                if (note.trim())
                  void act(async () => {
                    await api.addNote(u.id, note)
                    setNote('')
                  })
              }}
            >
              <label className="flex-1">
                <span className="sr-only">메모</span>
                <input className={field} maxLength={2000} placeholder="문의 내용, 조치 이유 등 (관리자만 봐요)" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button className={btn.primary}>남기기</button>
            </form>
            {u.notes.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">메모가 없어요.</p>
            ) : (
              <ul className="divide-y divide-line">
                {u.notes.map((n) => (
                  <li key={n.id} className="flex flex-col gap-1 px-4 py-2.5 text-sm">
                    <span className="whitespace-pre-wrap">{n.body}</span>
                    <span className="text-xs text-muted">
                      {n.author} · {dateTimeText(n.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="이 사용자에 대한 관리 기록">
            {history.length === 0 ? (
              <p className="px-4 py-4 text-sm text-muted">기록이 없어요.</p>
            ) : (
              <ul className="divide-y divide-line">
                {history.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-3 px-4 py-2 text-sm">
                    <span className="font-mono text-xs text-muted">{dateTimeText(e.createdAt)}</span>
                    <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                    {e.detail && <span className="text-muted">{e.detail}</span>}
                    <span className="ml-auto text-xs text-muted">{e.actor}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card title="AI 사용 (30일)">
            <p className="border-b border-line px-4 py-2.5 text-xs text-muted">
              {u.isOwner ? '서버 Claude 구독 사용 가능 · ' : ''}내 AI 연결 {u.aiConnections}개
            </p>
            <ul className="flex flex-col gap-1.5 px-4 py-3 text-sm">
              {Object.keys(AI_FEATURE).map((f) => (
                <li key={f} className="flex justify-between">
                  <span className="text-ink-2">{AI_FEATURE[f]}</span>
                  <span className="font-mono">{u.aiByFeature[f] ?? 0}회</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="조치">
            <div className="flex flex-col gap-2 px-4 py-4">
              {locked ? (
                <p className="text-sm text-muted">소유자 계정은 정지하거나 삭제할 수 없어요.</p>
              ) : (
                <button
                  className={btn.secondary}
                  onClick={() => act(() => api.setUserStatus(u.id, u.status === 'active' ? 'suspended' : 'active'))}
                >
                  {u.status === 'active' ? '이용 정지 (바로 로그아웃)' : '정지 해제'}
                </button>
              )}
              <button className={btn.secondary} onClick={() => act(async () => setLink((await api.resetLink(u.id)).url))}>
                비밀번호 재설정 링크 만들기
              </button>
              {link && <CopyOnce label="재설정 링크" value={link} note="본인에게만 전달하세요. 24시간 동안 한 번 쓸 수 있어요." />}
              {!locked && (
                <button className={`${btn.ghost} text-danger`} onClick={() => setConfirmDelete(true)}>
                  계정 삭제…
                </button>
              )}
            </div>
          </Card>
        </div>
      </div>

      {confirmDelete && (
        <Reauth
          title="계정 삭제"
          danger
          confirmLabel="영구 삭제"
          message={
            <>
              <b>{u.email}</b> 계정과 모든 일정·할 일이 지워지고 되돌릴 수 없어요.
            </>
          }
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async (password) => {
            await api.deleteUser(u.id, password)
            navigate('/users', { replace: true })
          }}
        />
      )}
    </>
  )
}
