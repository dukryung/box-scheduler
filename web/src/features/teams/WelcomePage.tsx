import { useState } from 'react'
import { useNavigate } from 'react-router'
import { teamApi } from '../../api/client'
import { Logo } from '../../components/icons'
import { primaryButton, secondaryButton } from '../../components/styles'
import { todayISO } from '../../lib/date'
import { useAuth } from '../../store/authStore'
import { useTeams } from '../../store/teamsStore'

/** Asked once after signing up: personal use, a new team, or waiting for an invite. */
export function WelcomePage() {
  const navigate = useNavigate()
  const { user, setUser } = useAuth()
  const reloadTeams = useTeams((s) => s.load)
  const [mode, setMode] = useState<'personal' | 'team' | 'invited' | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const done = () => user && setUser({ ...user, onboarded: true })
  const personal = async () => {
    setBusy(true)
    await teamApi.onboarded().catch(() => {})
    done()
    navigate(`/day/${todayISO()}`, { replace: true })
  }
  const createTeam = async () => {
    setBusy(true)
    setError(null)
    try {
      const t = await teamApi.create(name)
      done()
      await reloadTeams()
      navigate(`/team/${t.id}?invite=1`, { replace: true })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const option = (key: typeof mode, title: string, desc: string) => (
    <button
      role="radio"
      aria-checked={mode === key}
      onClick={() => setMode(key)}
      className={`flex flex-col gap-1 rounded-xl border p-4 text-left ${mode === key ? 'border-accent bg-accent-soft' : 'border-line hover:bg-subtle'}`}
    >
      <span className="text-[15px] font-semibold">{title}</span>
      <span className="text-sm text-muted">{desc}</span>
    </button>
  )

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <main className="mx-auto flex w-full max-w-[460px] flex-1 flex-col gap-5 px-4 pt-[8vh] pb-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo size={36} />
          <h1 className="text-2xl font-bold tracking-tight">어떻게 쓰실 건가요?</h1>
          <p className="text-sm text-muted">나중에 언제든 팀을 만들거나 초대받을 수 있어요. 내 시간표는 어느 쪽이든 그대로 있어요.</p>
        </div>
        <div role="radiogroup" aria-label="쓰는 방식" className="flex flex-col gap-2">
          {option('personal', '혼자 쓸게요', '내 하루를 10분 단위로 계획해요.')}
          {option('team', '팀을 만들게요', '팀 업무를 나누고 멤버를 이메일로 초대해요.')}
          {option('invited', '초대받았어요', '초대 메일의 링크로 팀에 들어가요.')}
        </div>
        {mode === 'personal' && (
          <button className={`${primaryButton} h-12`} disabled={busy} onClick={() => void personal()}>
            시작하기
          </button>
        )}
        {mode === 'team' && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void createTeam()
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
              팀 이름
              <input
                required
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="예: 개발팀"
                className="h-12 rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent"
              />
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button className={`${primaryButton} h-12`} disabled={busy || !name.trim()}>
              팀 만들고 초대하러 가기
            </button>
          </form>
        )}
        {mode === 'invited' && (
          <div className="flex flex-col gap-2">
            <p className="rounded-xl bg-subtle px-4 py-3 text-sm leading-relaxed text-ink-2">
              받은 초대 메일에서 <b>초대 수락하기</b>를 눌러 주세요. 이 계정({user?.email})과 같은 이메일로 받은 초대여야 해요.
            </p>
            <button className={`${secondaryButton} h-12`} disabled={busy} onClick={() => void personal()}>
              우선 혼자 시작하기
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
