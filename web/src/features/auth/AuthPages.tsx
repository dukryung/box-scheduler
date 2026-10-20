import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { authApi } from '../../api/client'
import type { User } from '../../api/types'
import { Logo } from '../../components/icons'
import { primaryButton } from '../../components/styles'
import { ThemeToggle } from '../../components/ThemeToggle'
import { todayISO } from '../../lib/date'
import { useAuth } from '../../store/authStore'
import { googleError, useGoogleEnabled } from './google'
import { Divider, GoogleButton } from './GoogleButton'

const field =
  'h-12 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent md:h-11 md:text-sm'

function Shell({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>
      <main className="mx-auto flex w-full max-w-[400px] flex-1 flex-col gap-6 px-4 pt-[6vh] pb-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo size={36} />
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm leading-relaxed text-muted">{subtitle}</p>}
        </div>
        <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 md:p-6">{children}</div>
        {footer && <div className="text-center text-sm text-muted">{footer}</div>}
      </main>
    </div>
  )
}

function Field({ label, ...rest }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
      {label}
      <input className={field} {...rest} />
    </label>
  )
}

/** Sends a form once at a time and shows its error. */
function useSubmit(run: () => Promise<User>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setUser = useAuth((s) => s.setUser)
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      setUser(await run())
      const next = params.get('next')
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : `/day/${todayISO()}`, { replace: true })
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return { busy, error, onSubmit }
}

const ErrorText = ({ error }: { error: string | null }) =>
  error ? (
    <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
      {error}
    </p>
  ) : null

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [params] = useSearchParams()
  const { busy, error, onSubmit } = useSubmit(() => authApi.login(email, password))
  const google = useGoogleEnabled()
  const linkError = googleError(params.get('error'))
  return (
    <Shell
      title="로그인"
      subtitle="10분 단위 상자로 하루를 계획해요."
      footer={
        <>
          처음이신가요?{' '}
          <Link to="/signup" className="font-semibold text-accent dark:text-accent-bright">
            가입하기
          </Link>
        </>
      }
    >
      {params.get('expired') && <p className="text-sm text-muted">로그인이 끝났어요. 다시 로그인해 주세요.</p>}
      <ErrorText error={linkError} />
      {google && (
        <>
          <GoogleButton href={authApi.googleStartURL({ next: params.get('next') ?? undefined })} />
          <Divider />
        </>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="이메일" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="비밀번호" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText error={error} />
        <button className={`${primaryButton} h-12`} disabled={busy}>
          {busy ? '로그인하는 중…' : '로그인'}
        </button>
      </form>
      <p className="text-xs leading-relaxed text-muted">비밀번호를 잊었다면 어드민에게 재설정 링크를 받아 주세요.</p>
    </Shell>
  )
}

export function SignupPage() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, onSubmit } = useSubmit(() => authApi.signup(email, password, name))
  const google = useGoogleEnabled()
  return (
    <Shell
      title="가입하기"
      subtitle="가입하면 바로 쓸 수 있어요."
      footer={
        <>
          이미 계정이 있나요?{' '}
          <Link to="/login" className="font-semibold text-accent dark:text-accent-bright">
            로그인
          </Link>
        </>
      }
    >
      {google && (
        <>
          <GoogleButton href={authApi.googleStartURL({})} label="Google로 가입하기" />
          <Divider />
        </>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="이름 (선택)" autoComplete="name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="이메일" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label="비밀번호 (8자 이상)"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorText error={error} />
        <button className={`${primaryButton} h-12`} disabled={busy}>
          {busy ? '가입하는 중…' : '가입하기'}
        </button>
      </form>
    </Shell>
  )
}

/** First run: the owner claims the account that holds the existing data. */
export function SetupPage() {
  const [params] = useSearchParams()
  const [needed, setNeeded] = useState<boolean | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const token = params.get('token') ?? ''
  const { busy, error, onSubmit } = useSubmit(() => authApi.setup(token, email, password, name))
  const google = useGoogleEnabled()

  useEffect(() => {
    authApi.setupNeeded().then((r) => setNeeded(r.needed), () => setNeeded(false))
  }, [])

  if (needed === null) return null
  if (!needed)
    return (
      <Shell title="설정을 마쳤어요" subtitle="소유자 계정은 이미 만들어졌어요.">
        <Link to="/login" className={`${primaryButton} h-12`}>
          로그인하러 가기
        </Link>
      </Shell>
    )
  return (
    <Shell title="소유자 계정 만들기" subtitle="지금까지의 일정과 할 일은 이 계정으로 이어져요. 이 계정이 첫 어드민이 돼요.">
      {params.get('error') === 'token' && <ErrorText error="설정 링크가 맞지 않아요. 서버 로그에 나온 링크로 열어 주세요." />}
      {google && token && (
        <>
          <GoogleButton href={authApi.googleStartURL({ setup: token })} label="Google로 소유자 계정 만들기" />
          <Divider />
        </>
      )}
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label="이름" autoComplete="name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
        <Field label="이메일" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label="비밀번호 (8자 이상)"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {!token && <p className="text-sm text-danger">서버 로그에 나온 설정 링크로 열어 주세요.</p>}
        <ErrorText error={error} />
        <button className={`${primaryButton} h-12`} disabled={busy || !token}>
          {busy ? '만드는 중…' : '계정 만들기'}
        </button>
      </form>
    </Shell>
  )
}

export function ResetPage() {
  const [params] = useSearchParams()
  const [password, setPassword] = useState('')
  const token = params.get('token') ?? ''
  const { busy, error, onSubmit } = useSubmit(() => authApi.reset(token, password))
  return (
    <Shell title="새 비밀번호 정하기" subtitle="링크는 한 번만, 24시간 안에 쓸 수 있어요. 바꾸면 다른 기기에서는 로그아웃돼요.">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field
          label="새 비밀번호 (8자 이상)"
          type="password"
          autoComplete="new-password"
          minLength={8}
          maxLength={128}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <ErrorText error={error} />
        <button className={`${primaryButton} h-12`} disabled={busy || !token}>
          {busy ? '바꾸는 중…' : '비밀번호 바꾸기'}
        </button>
      </form>
    </Shell>
  )
}
