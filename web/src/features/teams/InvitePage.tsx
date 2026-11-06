import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { teamApi } from '../../api/client'
import type { InviteInfo } from '../../api/types'
import { Logo } from '../../components/icons'
import { primaryButton, secondaryButton } from '../../components/styles'
import { ThemeToggle } from '../../components/ThemeToggle'
import { useAuth } from '../../store/authStore'
import { useTeams } from '../../store/teamsStore'

const ROLE = { manager: 'manager', member: 'member' } as const

/** /invite/:token — what the email's link opens, signed in or not. */
export function InvitePage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const { user, logout, setUser } = useAuth()
  const reloadTeams = useTeams((s) => s.load)
  const [info, setInfo] = useState<InviteInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const next = encodeURIComponent(`/invite/${token}`)

  useEffect(() => {
    teamApi.inviteInfo(token).then(setInfo, (e: Error) => setError(e.message))
  }, [token])

  const accept = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await teamApi.accept(token)
      // Joining a team counts as having chosen how to use the app.
      if (user) setUser({ ...user, onboarded: true })
      await reloadTeams()
      navigate(`/team/${r.teamId}`, { replace: true })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  const matches = user && info && user.email.toLowerCase() === info.email.toLowerCase()
  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <div className="flex justify-end p-4">
        <ThemeToggle />
      </div>
      <main className="mx-auto flex w-full max-w-[420px] flex-1 flex-col gap-5 px-4 pt-[6vh]">
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo size={36} />
          <h1 className="text-2xl font-bold tracking-tight">팀 초대</h1>
        </div>
        <div className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
          {!info && !error && <p className="text-sm text-muted">초대를 확인하고 있어요…</p>}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {info && info.status !== 'pending' && (
            <p className="text-sm leading-relaxed text-ink-2">
              {info.status === 'accepted' ? '이미 수락한 초대예요.' : info.status === 'expired' ? '기간이 지난 초대예요.' : '취소된 초대예요.'} 초대한 사람에게 다시 보내 달라고
              해 주세요.
            </p>
          )}
          {info && info.status === 'pending' && (
            <>
              <p className="text-[15px] leading-relaxed">
                <b>{info.invitedBy}</b>님이 <b>‘{info.team}’</b> 팀에 <b>{ROLE[info.role]}</b>(으)로 초대했어요.
              </p>
              <p className="text-sm text-muted">
                초대받은 이메일: <span className="font-medium text-ink-2">{info.email}</span>
              </p>
              {!user && (
                <div className="flex flex-col gap-2">
                  <Link to={`/signup?next=${next}&email=${encodeURIComponent(info.email)}`} className={`${primaryButton} h-12`}>
                    가입하고 참여하기
                  </Link>
                  <Link to={`/login?next=${next}`} className={`${secondaryButton} h-12`}>
                    이미 계정이 있어요 · 로그인
                  </Link>
                  <p className="text-xs text-muted">초대받은 이메일({info.email})로 가입하거나 로그인해야 들어갈 수 있어요. Google 로그인도 그 이메일이면 돼요.</p>
                </div>
              )}
              {user && matches && (
                <button className={`${primaryButton} h-12`} disabled={busy} onClick={() => void accept()}>
                  {busy ? '들어가는 중…' : `‘${info.team}’ 팀에 참여하기`}
                </button>
              )}
              {user && !matches && (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-danger">
                    지금 로그인한 계정({user.email})은 초대받은 이메일과 달라요. {info.email}로 로그인해 주세요.
                  </p>
                  <button className={`${secondaryButton} h-11`} onClick={() => void logout()}>
                    로그아웃하고 다른 계정으로
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  )
}
