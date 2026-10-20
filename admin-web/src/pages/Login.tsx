import QRCode from 'qrcode'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { api, type Admin, type Stage } from '../api'
import { btn, field } from '../format'
import { useSession } from '../session'
import { ErrorText, Logo, ThemeToggle } from '../ui'

function Shell({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <div className="flex items-center justify-between px-5 py-4">
        <span className="flex items-center gap-2 text-sm font-semibold text-ink-2">
          <Logo size={22} /> Box Scheduler 관리자
        </span>
        <ThemeToggle />
      </div>
      <main className="mx-auto flex w-full max-w-[380px] flex-1 flex-col gap-5 px-4 pt-[8vh] pb-10">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm leading-relaxed text-muted">{subtitle}</p>}
        </div>
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5">{children}</div>
        <p className="text-center text-xs text-faint">관리자 계정은 서버에서만 만들 수 있어요. 모든 접속은 기록돼요.</p>
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

function useStep<T>(run: () => Promise<T>, done: (r: T) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      done(await run())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, submit }
}

/** Sign-in in steps: password → (new password) → (two-factor setup) → code. */
export function Login() {
  const { account, stage, set } = useSession()
  const navigate = useNavigate()
  const [params] = useSearchParams()

  useEffect(() => {
    if (account && stage === 'ok') navigate(params.get('next')?.startsWith('/') ? params.get('next')! : '/', { replace: true })
  }, [account, stage, navigate, params])

  if (account === undefined) return null
  if (!account || !stage) return <PasswordStep expired={!!params.get('expired')} onDone={set} />
  if (stage === 'password') return <ChangePasswordStep onDone={set} />
  if (stage === 'enroll') return <EnrollStep email={account.email} onDone={set} />
  if (stage === 'totp') return <CodeStep onDone={set} />
  return null
}

type Done = (account: Admin, stage: Stage) => void

function PasswordStep({ expired, onDone }: { expired: boolean; onDone: Done }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const { busy, error, submit } = useStep(() => api.login(email, password), (r) => onDone(r.account, r.stage))
  return (
    <Shell title="관리자 로그인" subtitle={expired ? '로그인이 끝났어요. 다시 로그인해 주세요.' : '서비스 계정이 아니라 관리자 계정으로 로그인해요.'}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="이메일" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field label="비밀번호" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorText error={error} />
        <button className={`${btn.primary} h-10`} disabled={busy}>
          {busy ? '확인하는 중…' : '다음'}
        </button>
      </form>
    </Shell>
  )
}

function ChangePasswordStep({ onDone }: { onDone: Done }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const { busy, error, submit } = useStep(() => api.changePassword(current, next), (r) => onDone(r.account, r.stage))
  return (
    <Shell title="새 비밀번호 정하기" subtitle="처음 받은 임시 비밀번호는 바로 바꿔야 해요. 12자 이상으로 정해 주세요.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="임시 비밀번호" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <Field label="새 비밀번호 (12자 이상)" type="password" autoComplete="new-password" minLength={12} maxLength={128} required value={next} onChange={(e) => setNext(e.target.value)} />
        <ErrorText error={error} />
        <button className={`${btn.primary} h-10`} disabled={busy}>
          비밀번호 바꾸기
        </button>
      </form>
    </Shell>
  )
}

function EnrollStep({ email, onDone }: { email: string; onDone: Done }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const { busy, error, submit } = useStep(() => api.totpVerify(code), (r) => onDone(r.account, r.stage))

  useEffect(() => {
    api.totpSetup().then(
      async (s) => setSetup({ ...s, qr: await QRCode.toDataURL(s.uri, { margin: 1, width: 200 }) }),
      (e: Error) => setLoadError(e.message),
    )
  }, [])

  return (
    <Shell title="2단계 인증 설정" subtitle={<>Google Authenticator, 1Password 같은 인증 앱으로 QR 코드를 찍고, 앱에 나온 6자리 코드를 입력하세요. ({email})</>}>
      <ErrorText error={loadError} />
      {setup && (
        <div className="flex flex-col items-center gap-3">
          <img src={setup.qr} alt="2단계 인증 QR 코드" width={200} height={200} className="rounded-lg bg-white p-2" />
          <details className="w-full text-xs text-muted">
            <summary className="cursor-pointer">QR 코드를 찍을 수 없나요?</summary>
            <p className="mt-2">앱에서 ‘키 직접 입력’을 고르고 이 키를 넣으세요.</p>
            <code data-testid="totp-secret" className="mt-1 block rounded-md bg-subtle px-2 py-1.5 font-mono break-all text-ink">
              {setup.secret}
            </code>
          </details>
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="인증 코드 6자리"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <ErrorText error={error} />
        <button className={`${btn.primary} h-10`} disabled={busy || !setup}>
          설정 마치기
        </button>
      </form>
    </Shell>
  )
}

function CodeStep({ onDone }: { onDone: Done }) {
  const [code, setCode] = useState('')
  const { busy, error, submit } = useStep(() => api.totpVerify(code), (r) => onDone(r.account, r.stage))
  return (
    <Shell title="인증 코드" subtitle="인증 앱에 보이는 6자리 코드를 입력하세요.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field
          label="인증 코드 6자리"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          pattern="[0-9 ]{6,7}"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <ErrorText error={error} />
        <button className={`${btn.primary} h-10`} disabled={busy}>
          로그인
        </button>
      </form>
    </Shell>
  )
}
