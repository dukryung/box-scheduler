import { useState, type FormEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { authApi } from '../../api/client'
import { card, primaryButton, secondaryButton } from '../../components/styles'
import { ThemeToggle } from '../../components/ThemeToggle'
import { todayISO } from '../../lib/date'
import { useAuth } from '../../store/authStore'
import { useGoogleEnabled } from '../auth/google'
import { GoogleButton } from '../auth/GoogleButton'
import { BottomTabs, TopBar, ViewSwitch } from '../nav/ViewSwitch'
import { AIConnections } from './AIConnections'

const field = 'h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent md:text-sm'

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-label={title} className={`${card} flex flex-col gap-4 p-5`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Note({ text, tone = 'muted' }: { text: string | null; tone?: 'muted' | 'danger' | 'good' }) {
  if (!text) return null
  const color = tone === 'danger' ? 'text-danger' : tone === 'good' ? 'text-good' : 'text-muted'
  return (
    <p role={tone === 'danger' ? 'alert' : 'status'} className={`text-sm ${color}`}>
      {text}
    </p>
  )
}

export function SettingsView() {
  const { user, setUser, logout } = useAuth()
  const [name, setName] = useState(user?.name ?? '')
  const [nameNote, setNameNote] = useState<string | null>(null)
  const [pw, setPw] = useState({ current: '', next: '' })
  const [pwNote, setPwNote] = useState<{ text: string; tone: 'danger' | 'good' } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deletePw, setDeletePw] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [googleNote, setGoogleNote] = useState<string | null>(null)
  const [params] = useSearchParams()
  const googleOn = useGoogleEnabled()
  const linked = params.get('google')
  if (!user) return null

  const unlinkGoogle = async () => {
    try {
      setUser(await authApi.googleUnlink())
      setGoogleNote('Google 연결을 끊었어요.')
    } catch (err) {
      setGoogleNote((err as Error).message)
    }
  }

  const saveName = async (e: FormEvent) => {
    e.preventDefault()
    try {
      setUser(await authApi.updateMe(name))
      setNameNote('저장했어요.')
    } catch (err) {
      setNameNote((err as Error).message)
    }
  }
  const savePassword = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await authApi.changePassword(pw.current, pw.next)
      setPw({ current: '', next: '' })
      if (!user.hasPassword) setUser({ ...user, hasPassword: true })
      setPwNote({
        text: user.hasPassword ? '비밀번호를 바꿨어요. 다른 기기에서는 로그아웃됐어요.' : '비밀번호를 정했어요. 이제 이메일로도 로그인할 수 있어요.',
        tone: 'good',
      })
    } catch (err) {
      setPwNote({ text: (err as Error).message, tone: 'danger' })
    }
  }
  const deleteAccount = async (e: FormEvent) => {
    e.preventDefault()
    try {
      await authApi.deleteMe(user.hasPassword ? { password: deletePw } : { confirm: deletePw })
      window.location.assign('/login')
    } catch (err) {
      setDeleteError((err as Error).message)
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <TopBar phoneTheme>
        <h1 className="flex-1 text-center text-[17px] font-semibold md:flex-none md:pl-2 md:text-left md:text-lg">설정</h1>
        <div className="ml-auto hidden md:block">
          <ViewSwitch view="other" date={todayISO()} />
        </div>
      </TopBar>

      <main className="mx-auto flex w-full max-w-[640px] flex-col gap-3 px-4 pt-3 pb-[104px] md:gap-4 md:px-6 md:pt-6 md:pb-10">
        <Section
          title="내 계정"
          aside={
            <span className="flex gap-1.5">
              {user.isOwner && <span className="rounded-md bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-ink">소유자</span>}
            </span>
          }
        >
          <p className="text-sm text-ink-2">
            <span className="text-muted">이메일 · </span>
            {user.email}
          </p>
          <form onSubmit={saveName} className="flex flex-col gap-2">
            <label htmlFor="settings-name" className="text-sm font-medium text-ink-2">
              이름
            </label>
            <div className="flex gap-2">
              <input id="settings-name" className={field} maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
              <button className={`${secondaryButton} h-11 shrink-0`}>저장</button>
            </div>
            <Note text={nameNote} />
          </form>
        </Section>

        <Section title="AI 연결">
          <AIConnections />
        </Section>

        <Section title="화면 모드" aside={<ThemeToggle />}>
          <p className="text-sm text-muted">버튼을 누를 때마다 시스템 설정 → 라이트 → 다크 순으로 바뀌어요.</p>
        </Section>

        <Section title="로그인 방법">
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-2">이메일 + 비밀번호</span>
              <span className={user.hasPassword ? 'font-semibold text-good' : 'text-muted'}>{user.hasPassword ? '사용 중' : '없음 (아래에서 정할 수 있어요)'}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-ink-2">Google</span>
              {user.google ? (
                <span className="flex items-center gap-3">
                  <span className="font-semibold text-good">연결됨</span>
                  {user.hasPassword && (
                    <button onClick={() => void unlinkGoogle()} className="text-sm text-muted underline hover:text-ink">
                      연결 끊기
                    </button>
                  )}
                </span>
              ) : googleOn ? (
                <span className="w-full sm:w-auto">
                  <GoogleButton href={authApi.googleStartURL({ link: true })} label="Google 연결하기" />
                </span>
              ) : (
                <span className="text-muted">서버에 아직 설정되지 않았어요</span>
              )}
            </div>
            {linked === 'linked' && <Note text="Google 계정을 연결했어요. 이제 Google로도 로그인할 수 있어요." tone="good" />}
            {linked === 'taken' && <Note text="그 Google 계정은 이미 다른 계정에 연결돼 있어요." tone="danger" />}
            <Note text={googleNote} />
          </div>
        </Section>

        <Section title={user.hasPassword ? '비밀번호 바꾸기' : '비밀번호 정하기'}>
          <form onSubmit={savePassword} className="flex flex-col gap-3">
            {user.hasPassword && (
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                지금 비밀번호
                <input
                  type="password"
                  autoComplete="current-password"
                  required
                  className={field}
                  value={pw.current}
                  onChange={(e) => setPw({ ...pw, current: e.target.value })}
                />
              </label>
            )}
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
              새 비밀번호 (8자 이상)
              <input
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                required
                className={field}
                value={pw.next}
                onChange={(e) => setPw({ ...pw, next: e.target.value })}
              />
            </label>
            <Note text={pwNote?.text ?? null} tone={pwNote?.tone} />
            <button className={`${primaryButton} h-11 self-start`}>{user.hasPassword ? '비밀번호 바꾸기' : '비밀번호 정하기'}</button>
          </form>
        </Section>

        <div className="flex flex-wrap gap-2">
          <button onClick={() => void logout()} className={`${secondaryButton} h-11`}>
            로그아웃
          </button>
          {!user.isOwner && !deleting && (
            <button onClick={() => setDeleting(true)} className="h-11 rounded-xl px-4 text-sm text-danger hover:bg-danger/10">
              계정 삭제
            </button>
          )}
        </div>

        {deleting && (
          <Section title="계정 삭제">
            <form onSubmit={deleteAccount} className="flex flex-col gap-3">
              <p className="text-sm leading-relaxed text-ink-2">
                계정과 모든 일정·할 일이 바로 지워지고 되돌릴 수 없어요. 계속하려면 {user.hasPassword ? '비밀번호를' : `이메일(${user.email})을`} 입력하세요.
              </p>
              <input
                type={user.hasPassword ? 'password' : 'email'}
                aria-label={user.hasPassword ? '비밀번호 확인' : '이메일 확인'}
                autoComplete="current-password"
                required
                className={field}
                value={deletePw}
                onChange={(e) => setDeletePw(e.target.value)}
              />
              <Note text={deleteError} tone="danger" />
              <div className="flex gap-2">
                <button type="button" onClick={() => setDeleting(false)} className={`${secondaryButton} h-11`}>
                  취소
                </button>
                <button className="h-11 rounded-xl bg-danger px-4 text-sm font-semibold text-white">계정 영구 삭제</button>
              </div>
            </form>
          </Section>
        )}
      </main>

      <BottomTabs view="other" date={todayISO()} />
    </div>
  )
}
