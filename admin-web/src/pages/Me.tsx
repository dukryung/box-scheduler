import { useState } from 'react'
import { api } from '../api'
import { btn, dateTimeText, field } from '../format'
import { useSession } from '../session'
import { Card, ErrorText, PageHeader } from '../ui'

export function Me() {
  const { account, set } = useSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!account) return null
  return (
    <>
      <PageHeader title="내 정보" />
      <Card title="관리자 계정">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 text-sm sm:grid-cols-4">
          {[
            ['이메일', account.email],
            ['역할', account.role === 'super' ? '최고 관리자' : '운영자'],
            ['2단계 인증', account.totpEnabled ? '사용 중' : '미설정'],
            ['마지막 로그인', dateTimeText(account.lastLoginAt)],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="border-t border-line px-4 py-2.5 text-xs text-muted">
          인증 앱을 바꾸려면 다른 최고 관리자에게 초기화를 부탁하거나, 서버에서 <code>admin reset --email …</code>을 실행하세요.
        </p>
      </Card>
      <Card title="비밀번호 바꾸기">
        <form
          className="flex max-w-sm flex-col gap-3 px-4 py-4"
          onSubmit={async (e) => {
            e.preventDefault()
            setError(null)
            setNote(null)
            try {
              const r = await api.changePassword(current, next)
              set(r.account, r.stage)
              setCurrent('')
              setNext('')
              setNote('비밀번호를 바꿨어요. 다른 기기에서는 로그아웃됐어요.')
            } catch (err) {
              setError((err as Error).message)
            }
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            지금 비밀번호
            <input type="password" autoComplete="current-password" required className={field} value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            새 비밀번호 (12자 이상)
            <input type="password" autoComplete="new-password" minLength={12} required className={field} value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <ErrorText error={error} />
          {note && <p className="text-sm text-good">{note}</p>}
          <button className={`${btn.primary} self-start`}>바꾸기</button>
        </form>
      </Card>
    </>
  )
}
