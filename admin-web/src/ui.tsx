import { useState, type ReactNode, type SVGProps } from 'react'
import { btn, field } from './format'
import { nextThemePref, setThemePref, useThemePref } from './theme'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }
function Stroke({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  )
}
export const IconDashboard = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </Stroke>
)
export const IconUsers = (p: IconProps) => (
  <Stroke {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14a6 6 0 0 1 3 6" />
  </Stroke>
)
export const IconLog = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M7 4h11a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3z" />
    <path d="M8 9h8M8 13h8M8 17h5" />
  </Stroke>
)
export const IconShield = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.1-8 9-4.6-.9-8-4.5-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </Stroke>
)
export const IconLogout = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />
  </Stroke>
)
export const IconMenu = (p: IconProps) => (
  <Stroke {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Stroke>
)

export const IconChip = (p: IconProps) => (
  <Stroke {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </Stroke>
)

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <rect x="1" y="1" width="24" height="24" rx="6" className="fill-ink" />
      <rect x="6" y="6" width="6" height="6" rx="1.5" className="fill-accent-bright" />
      <rect x="14" y="14" width="6" height="6" rx="1.5" fill="#14b8a6" />
      <rect x="14" y="6" width="6" height="6" rx="1.5" className="fill-accent-bright" opacity="0.4" />
      <rect x="6" y="14" width="6" height="6" rx="1.5" fill="#14b8a6" opacity="0.4" />
    </svg>
  )
}

const LABEL = { system: '시스템 설정', light: '라이트', dark: '다크' } as const
export function ThemeToggle() {
  const pref = useThemePref()
  const next = nextThemePref(pref)
  return (
    <button onClick={() => setThemePref(next)} aria-label={`화면 모드: ${LABEL[pref]} (눌러서 ${LABEL[next]}로 바꾸기)`} title={`화면 모드: ${LABEL[pref]}`} className={btn.ghost}>
      {pref === 'light' ? (
        <Stroke>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </Stroke>
      ) : pref === 'dark' ? (
        <Stroke>
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </Stroke>
      ) : (
        <Stroke>
          <rect x="3" y="4" width="18" height="12" rx="2" />
          <path d="M8 20h8M12 16v4" />
        </Stroke>
      )}
      <span className="hidden text-xs xl:inline">{LABEL[pref]}</span>
    </button>
  )
}

export function Card({ title, aside, children, className = '' }: { title?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={`rounded-xl border border-line bg-surface ${className}`}>
      {title && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface px-4 py-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-2xl font-bold tracking-tight">{value}</span>
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </div>
  )
}

const TONE = {
  neutral: 'bg-subtle text-ink-2',
  accent: 'bg-accent-soft text-accent-ink',
  danger: 'bg-danger/10 text-danger',
  good: 'bg-good/10 text-good',
  ai: 'bg-ai-soft text-ai-ink',
}
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof TONE; children: ReactNode }) {
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${TONE[tone]}`}>{children}</span>
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h1 className="text-xl font-bold tracking-tight">{title}</h1>
      {children}
    </div>
  )
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
      {error}
    </p>
  )
}

/** Asks for the admin's password again before a destructive action. */
export function Reauth({
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string
  message: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: (password: string) => Promise<void>
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        role="dialog"
        aria-label={title}
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-xl"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await onConfirm(password)
          } catch (err) {
            setError((err as Error).message)
            setBusy(false)
          }
        }}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="text-sm leading-relaxed text-ink-2">{message}</div>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
          내 관리자 비밀번호
          <input type="password" autoFocus autoComplete="current-password" required className={field} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={btn.ghost}>
            취소
          </button>
          <button disabled={busy} className={danger ? btn.danger : btn.primary}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

/** A value to copy once (temporary password, reset link). */
export function CopyOnce({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent-soft p-3 text-sm text-accent-ink">
      <span>{note}</span>
      <div className="flex gap-2">
        <input readOnly aria-label={label} value={value} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs text-ink" onFocus={(e) => e.target.select()} />
        <button
          type="button"
          className={btn.secondary}
          onClick={async () => {
            await navigator.clipboard?.writeText(value).catch(() => {})
            setCopied(true)
          }}
        >
          {copied ? '복사됨' : '복사'}
        </button>
      </div>
    </div>
  )
}

export function Pager({ total, limit, offset, onPage }: { total: number; limit: number; offset: number; onPage: (offset: number) => void }) {
  if (total <= limit) return null
  const page = Math.floor(offset / limit) + 1
  const pages = Math.ceil(total / limit)
  return (
    <nav aria-label="페이지" className="flex items-center justify-end gap-2 px-4 py-3 text-sm text-muted">
      <button className={btn.secondary} disabled={page <= 1} onClick={() => onPage(offset - limit)}>
        이전
      </button>
      <span className="font-mono">
        {page} / {pages}
      </span>
      <button className={btn.secondary} disabled={page >= pages} onClick={() => onPage(offset + limit)}>
        다음
      </button>
    </nav>
  )
}
