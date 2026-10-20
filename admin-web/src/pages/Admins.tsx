import { useCallback, useEffect, useState } from 'react'
import { api, type Admin } from '../api'
import { ago, btn, dateText, field } from '../format'
import { useSession } from '../session'
import { Badge, Card, CopyOnce, ErrorText, PageHeader, Reauth } from '../ui'

type Pending = { title: string; label: string; danger?: boolean; message: string; run: (password: string) => Promise<void> }

/** Admin accounts (super admins only). Every change asks for the password again. */
export function Admins() {
  const me = useSession((s) => s.account)
  const [list, setList] = useState<Admin[]>([])
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ email: '', name: '', role: 'operator' as Admin['role'] })
  const [pending, setPending] = useState<Pending | null>(null)
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null)

  const load = useCallback(() => api.admins().then((r) => setList(r.admins), (e: Error) => setError(e.message)), [])
  useEffect(() => {
    void load()
  }, [load])

  const confirm = (p: Pending) =>
    setPending({
      ...p,
      run: async (password) => {
        await p.run(password)
        setPending(null)
        await load()
      },
    })

  return (
    <>
      <PageHeader title="관리자 계정" />
      <p className="text-sm text-muted">관리자는 처음 로그인할 때 임시 비밀번호를 바꾸고 2단계 인증을 설정해야 해요. 최고 관리자는 한 명 이상 남아 있어야 해요.</p>
      <ErrorText error={error} />
      {temp && <CopyOnce label="임시 비밀번호" value={temp.password} note={`${temp.email}의 임시 비밀번호예요. 지금 한 번만 보여요. 안전한 방법으로 전달하세요.`} />}

      <Card title="관리자 추가">
        <form
          className="grid gap-3 px-4 py-4 md:grid-cols-[2fr_1.5fr_1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            confirm({
              title: '관리자 추가',
              label: '추가',
              message: `${form.email}을(를) ${form.role === 'super' ? '최고 관리자' : '운영자'}로 추가할까요?`,
              run: async (password) => {
                const r = await api.createAdmin(form.email, form.name, form.role, password)
                setTemp({ email: r.admin.email, password: r.tempPassword })
                setForm({ email: '', name: '', role: 'operator' })
              },
            })
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            이메일
            <input type="email" required className={field} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            이름
            <input maxLength={40} className={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            역할
            <select className={field} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Admin['role'] })}>
              <option value="operator">운영자</option>
              <option value="super">최고 관리자</option>
            </select>
          </label>
          <button className={btn.primary}>추가</button>
        </form>
      </Card>

      <Card title={`관리자 ${list.length}`}>
        <ul className="divide-y divide-line">
          {list.map((a) => {
            const self = a.id === me?.id
            return (
              <li key={a.id} aria-label={a.email} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
                <div className="flex min-w-48 flex-1 flex-col">
                  <span className="font-medium">
                    {a.name || a.email} {self && <span className="text-xs text-muted">(나)</span>}
                  </span>
                  <span className="text-xs text-muted">{a.email}</span>
                </div>
                <span className="flex flex-wrap gap-1">
                  <Badge tone={a.role === 'super' ? 'accent' : 'neutral'}>{a.role === 'super' ? '최고 관리자' : '운영자'}</Badge>
                  {a.status === 'disabled' && <Badge tone="danger">중지</Badge>}
                  {!a.totpEnabled && <Badge tone="ai">2단계 미설정</Badge>}
                  {a.mustChangePassword && <Badge>임시 비밀번호</Badge>}
                </span>
                <span className="text-xs text-muted">
                  추가 {dateText(a.createdAt)} · 로그인 {ago(a.lastLoginAt)}
                </span>
                {!self && (
                  <span className="flex flex-wrap gap-1.5">
                    <button
                      className={btn.secondary}
                      onClick={() =>
                        confirm({
                          title: '역할 바꾸기',
                          label: '바꾸기',
                          message: `${a.email}을(를) ${a.role === 'super' ? '운영자' : '최고 관리자'}로 바꿀까요?`,
                          run: (pw) => api.updateAdmin(a.id, { role: a.role === 'super' ? 'operator' : 'super' }, pw).then(() => {}),
                        })
                      }
                    >
                      {a.role === 'super' ? '운영자로' : '최고 관리자로'}
                    </button>
                    <button
                      className={btn.secondary}
                      onClick={() =>
                        confirm({
                          title: a.status === 'active' ? '사용 중지' : '다시 사용',
                          label: a.status === 'active' ? '중지' : '사용',
                          danger: a.status === 'active',
                          message: a.status === 'active' ? `${a.email}을(를) 중지하면 바로 로그아웃돼요.` : `${a.email}을(를) 다시 쓸 수 있게 할까요?`,
                          run: (pw) => api.updateAdmin(a.id, { status: a.status === 'active' ? 'disabled' : 'active' }, pw).then(() => {}),
                        })
                      }
                    >
                      {a.status === 'active' ? '중지' : '다시 사용'}
                    </button>
                    <button
                      className={btn.secondary}
                      onClick={() =>
                        confirm({
                          title: '비밀번호·2단계 초기화',
                          label: '초기화',
                          danger: true,
                          message: `${a.email}에게 새 임시 비밀번호를 만들고 2단계 인증을 지워요. 바로 로그아웃돼요.`,
                          run: async (pw) => setTemp({ email: a.email, password: (await api.resetAdmin(a.id, pw)).tempPassword }),
                        })
                      }
                    >
                      초기화
                    </button>
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      </Card>

      {pending && (
        <Reauth title={pending.title} confirmLabel={pending.label} danger={pending.danger} message={pending.message} onCancel={() => setPending(null)} onConfirm={pending.run} />
      )}
    </>
  )
}
