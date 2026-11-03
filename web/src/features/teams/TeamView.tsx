import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { teamApi } from '../../api/client'
import type { InviteResult, TeamDetail, TeamMember, TeamRole } from '../../api/types'
import { ConfirmInline } from '../../components/ConfirmInline'
import { card, primaryButton, secondaryButton } from '../../components/styles'
import { todayISO } from '../../lib/date'
import { useAuth } from '../../store/authStore'
import { useTeams } from '../../store/teamsStore'
import { BottomTabs, TopBar, ViewSwitch } from '../nav/ViewSwitch'
import { TeamMeetings } from './TeamMeetings'
import { TeamMonth } from './TeamMonth'
import { TeamTasks } from './TeamTasks'

const ROLE_LABEL: Record<TeamRole, string> = { owner: 'owner', manager: '매니저', member: '일반' }
const rank = (r: TeamRole) => ({ member: 1, manager: 2, owner: 3 })[r]
const MAX_INVITES = 20
const field = 'h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent md:text-sm'

function RoleBadge({ role }: { role: TeamRole }) {
  const tone = role === 'owner' ? 'bg-accent-soft text-accent-ink' : role === 'manager' ? 'bg-ai-soft text-ai-ink' : 'bg-subtle text-ink-2'
  return <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${tone}`}>{ROLE_LABEL[role]}</span>
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-label={title} className={`${card} flex flex-col gap-3 p-4 md:p-5`}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

const dateText = (iso: string) => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex min-w-0 flex-1 gap-1.5">
      <input readOnly aria-label="초대 링크" value={link} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 font-mono text-[11px]" />
      <button
        type="button"
        className="rounded-md border border-line-strong px-2 text-xs hover:bg-subtle"
        onClick={async () => {
          await navigator.clipboard?.writeText(link).catch(() => {})
          setCopied(true)
        }}
      >
        {copied ? '복사됨' : '복사'}
      </button>
    </span>
  )
}

function MemberRow({ m, team, meId, onChanged }: { m: TeamMember; team: TeamDetail; meId: string; onChanged: (t?: TeamDetail) => void }) {
  const [confirm, setConfirm] = useState<'remove' | 'transfer' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const self = m.userId === meId
  const canRemove = !self && rank(team.role) >= 2 && rank(m.role) < rank(team.role)
  const act = async (fn: () => Promise<TeamDetail | void>) => {
    setError(null)
    try {
      onChanged((await fn()) ?? undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <li aria-label={m.email} className="flex flex-col gap-2 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-subtle text-sm font-bold text-ink-2">{(m.name || m.email).charAt(0).toUpperCase()}</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">
            {m.name || m.email.split('@')[0]} {self && <span className="text-xs text-muted">(나)</span>}
          </span>
          <span className="truncate text-xs text-muted">{m.email}</span>
        </div>
        {team.role === 'owner' && !self && m.role !== 'owner' ? (
          <select
            aria-label={`${m.email} 역할`}
            value={m.role}
            onChange={(e) => void act(() => teamApi.setRole(team.id, m.userId, e.target.value as 'manager' | 'member'))}
            className="h-8 rounded-md border border-line-strong bg-surface px-2 text-xs"
          >
            <option value="manager">매니저</option>
            <option value="member">일반</option>
          </select>
        ) : (
          <RoleBadge role={m.role} />
        )}
        {team.role === 'owner' && !self && (
          <button className="text-xs text-muted underline hover:text-ink" onClick={() => setConfirm('transfer')}>
            owner 넘기기
          </button>
        )}
        {canRemove && (
          <button className="text-xs text-danger hover:underline" onClick={() => setConfirm('remove')}>
            내보내기
          </button>
        )}
      </div>
      {confirm === 'remove' && (
        <ConfirmInline
          message={`${m.email}을(를) 팀에서 내보낼까요?`}
          confirmLabel="내보내기"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void act(() => teamApi.removeMember(team.id, m.userId))}
        />
      )}
      {confirm === 'transfer' && (
        <ConfirmInline
          message={`${m.email}에게 owner를 넘길까요? 나는 매니저가 돼요.`}
          confirmLabel="넘기기"
          onCancel={() => setConfirm(null)}
          onConfirm={() => void act(() => teamApi.transfer(team.id, m.userId))}
        />
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
    </li>
  )
}

/** A team's home: its tasks, and members, email invites and (for the owner) settings. */
export function TeamView() {
  const { teamId = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const asked = params.get('tab')
  const tab = params.get('invite') || asked === 'members' ? 'members' : asked === 'month' ? 'month' : asked === 'meetings' ? 'meetings' : 'tasks'
  const navigate = useNavigate()
  const me = useAuth((s) => s.user)
  const reloadTeams = useTeams((s) => s.load)
  const [team, setTeam] = useState<TeamDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [emails, setEmails] = useState([''])
  const emailInputs = useRef<(HTMLInputElement | null)[]>([])
  const focusRow = useRef<number | null>(null)
  const [role, setRole] = useState<'manager' | 'member'>('member')
  const [results, setResults] = useState<InviteResult[]>([])
  const [sending, setSending] = useState(false)
  const [name, setName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [leaving, setLeaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const t = await teamApi.get(teamId)
      setTeam(t)
      setName(t.name)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [teamId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (focusRow.current === null) return
    emailInputs.current[focusRow.current]?.focus()
    focusRow.current = null
  }, [emails])

  if (!team) return <div className="p-6 text-sm text-muted">{error ?? ''}</div>
  const canInvite = rank(team.role) >= 2
  const changed = (t?: TeamDetail) => (t ? setTeam(t) : void load())

  const filled = emails.map((e) => e.trim()).filter(Boolean)
  const setEmail = (i: number, v: string) => setEmails((list) => list.map((e, j) => (j === i ? v : e)))
  const addRow = () => {
    if (emails.length >= MAX_INVITES) return
    focusRow.current = emails.length
    setEmails((list) => [...list, ''])
  }
  const removeRow = (i: number) => {
    focusRow.current = Math.max(0, i - 1)
    setEmails((list) => list.filter((_, j) => j !== i))
  }

  const sendInvites = async () => {
    if (!filled.length) return
    setSending(true)
    try {
      const r = await teamApi.invite(team.id, filled, role)
      setResults(r.results)
      // Keep only the addresses that did not go through, so they can be fixed and sent again.
      const failed = r.results.filter((x) => !x.ok).map((x) => x.email)
      setEmails(failed.length ? failed : [''])
      await load()
    } catch (e) {
      setResults([{ email: '', ok: false, sent: false, error: (e as Error).message }])
    }
    setSending(false)
  }

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <TopBar phoneTheme>
        <h1 className="flex flex-1 items-center justify-center gap-2 text-[17px] font-semibold md:flex-none md:justify-start md:pl-2 md:text-lg">
          {team.name} <RoleBadge role={team.role} />
        </h1>
        <div className="ml-auto hidden md:block">
          <ViewSwitch view="other" date={todayISO()} />
        </div>
      </TopBar>

      <main className={`mx-auto flex w-full ${tab === 'members' ? 'max-w-[760px]' : tab === 'month' ? 'max-w-[1240px]' : 'max-w-[1080px]'} flex-col gap-3 px-4 pt-3 pb-[104px] md:gap-4 md:px-6 md:pt-6 md:pb-10`}>
        <nav role="tablist" aria-label="팀 화면" className="flex gap-1 border-b border-line">
          {(
            [
              ['tasks', '업무'],
              ['month', '월간 일정'],
              ['meetings', '회의'],
              ['members', `멤버 ${team.memberList.length}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setParams(k === 'tasks' ? {} : { tab: k }, { replace: true })}
              className={`-mb-px border-b-2 px-3 py-2 text-[15px] ${tab === k ? 'border-accent font-semibold text-ink' : 'border-transparent text-muted hover:text-ink'}`}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab === 'tasks' && <TeamTasks team={team} meId={me?.id ?? ''} />}
        {tab === 'month' && <TeamMonth team={team} meId={me?.id ?? ''} />}
        {tab === 'meetings' && <TeamMeetings team={team} />}

        {tab === 'members' && canInvite && (
          <Section title="이메일로 초대하기">
            {params.get('invite') && <p className="text-sm text-good">팀을 만들었어요. 함께할 사람을 초대해 보세요.</p>}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1.5 text-sm font-medium text-ink-2">이메일</legend>
              {emails.map((email, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    ref={(el) => {
                      emailInputs.current[i] = el
                    }}
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    aria-label={`초대할 이메일 ${i + 1}`}
                    value={email}
                    onChange={(e) => setEmail(i, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                      e.preventDefault()
                      if (i === emails.length - 1 && email.trim()) addRow()
                      else emailInputs.current[i + 1]?.focus()
                    }}
                    placeholder={i === 0 ? 'minji@example.com' : 'name@example.com'}
                    className={field}
                  />
                  {emails.length > 1 && (
                    <button
                      type="button"
                      aria-label={`이메일 ${i + 1} 지우기`}
                      onClick={() => removeRow(i)}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[10px] border border-line-strong text-lg text-muted hover:bg-subtle hover:text-ink"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {emails.length < MAX_INVITES && (
                <button type="button" onClick={addRow} className="flex h-10 items-center justify-center gap-1 rounded-[10px] border border-dashed border-line-strong text-sm font-medium text-ink-2 hover:bg-subtle hover:text-ink">
                  + 이메일 추가
                </button>
              )}
            </fieldset>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                역할
                <select value={role} onChange={(e) => setRole(e.target.value as 'manager' | 'member')} className="h-11 rounded-[10px] border border-line-strong bg-surface px-3 text-sm">
                  <option value="member">일반 — 내 업무 추가·수정, 할당받은 일 관리</option>
                  <option value="manager">매니저 — 모든 업무와 담당자 관리, 초대</option>
                </select>
              </label>
              <button className={`${primaryButton} h-11`} disabled={sending || !filled.length} onClick={() => void sendInvites()}>
                {sending ? '보내는 중…' : filled.length > 1 ? `${filled.length}명 초대 보내기` : '초대 보내기'}
              </button>
            </div>
            {!team.mailEnabled && <p className="text-xs text-muted">메일 발송이 아직 설정되지 않아, 초대하면 링크가 나와요. 링크를 직접 전달해 주세요.</p>}
            {results.length > 0 && (
              <ul className="flex flex-col gap-1.5 text-sm" aria-label="초대 결과">
                {results.map((r, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.email}</span>
                    {r.sent && <span className="text-good">메일을 보냈어요</span>}
                    {r.error && <span className="text-danger">{r.error}</span>}
                    {r.link && <CopyLink link={r.link} />}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {tab === 'members' && (
          <Section title={`멤버 ${team.memberList.length}`}>
            <ul className="flex flex-col divide-y divide-line">
              {team.memberList.map((m) => (
                <MemberRow key={m.userId} m={m} team={team} meId={me?.id ?? ''} onChanged={changed} />
              ))}
            </ul>
          </Section>
        )}

        {tab === 'members' && canInvite && team.invites.length > 0 && (
          <Section title={`대기 중인 초대 ${team.invites.length}`}>
            <ul className="flex flex-col divide-y divide-line">
              {team.invites.map((inv) => (
                <li key={inv.id} aria-label={inv.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate font-medium">{inv.email}</span>
                  <RoleBadge role={inv.role} />
                  <span className="text-xs text-muted">
                    {inv.sentAt ? '메일 보냄' : '링크만'} · {dateText(inv.expiresAt)}까지
                  </span>
                  <button
                    className="text-xs text-ink-2 underline"
                    onClick={async () => {
                      const r = await teamApi.resend(team.id, inv.id)
                      setResults([r])
                      await load()
                    }}
                  >
                    다시 보내기
                  </button>
                  <button
                    className="text-xs text-danger"
                    onClick={async () => {
                      await teamApi.revoke(team.id, inv.id)
                      await load()
                    }}
                  >
                    취소
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {tab === 'members' && team.role === 'owner' && (
          <Section title="팀 설정">
            <form
              className="flex gap-2"
              onSubmit={async (e) => {
                e.preventDefault()
                setTeam(await teamApi.rename(team.id, name))
                void reloadTeams()
              }}
            >
              <label className="sr-only" htmlFor="team-name">
                팀 이름
              </label>
              <input id="team-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} className={field} />
              <button className={`${secondaryButton} h-11 shrink-0`}>이름 바꾸기</button>
            </form>
            {!deleting ? (
              <button className="self-start text-sm text-danger hover:underline" onClick={() => setDeleting(true)}>
                팀 삭제…
              </button>
            ) : (
              <form
                className="flex flex-col gap-2 rounded-xl bg-danger/5 p-3"
                onSubmit={async (e) => {
                  e.preventDefault()
                  try {
                    await teamApi.remove(team.id, confirmName)
                    await reloadTeams()
                    navigate(`/day/${todayISO()}`, { replace: true })
                  } catch (err) {
                    setError((err as Error).message)
                  }
                }}
              >
                <p className="text-sm text-ink-2">팀과 팀의 초대가 모두 지워져요. 멤버들의 개인 일정은 그대로예요. 확인하려면 팀 이름 ‘{team.name}’을 입력하세요.</p>
                <input aria-label="확인용 팀 이름" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className={field} />
                <div className="flex gap-2">
                  <button type="button" className={`${secondaryButton} h-10`} onClick={() => setDeleting(false)}>
                    취소
                  </button>
                  <button className="h-10 rounded-xl bg-danger px-4 text-sm font-semibold text-white">팀 영구 삭제</button>
                </div>
                {error && <p className="text-sm text-danger">{error}</p>}
              </form>
            )}
          </Section>
        )}

        {tab === 'members' && team.role !== 'owner' && (
          <div className="flex flex-col gap-2">
            {!leaving ? (
              <button className="self-start text-sm text-danger hover:underline" onClick={() => setLeaving(true)}>
                팀 나가기
              </button>
            ) : (
              <ConfirmInline
                message={`‘${team.name}’ 팀에서 나갈까요? 다시 들어오려면 초대를 받아야 해요.`}
                confirmLabel="나가기"
                onCancel={() => setLeaving(false)}
                onConfirm={async () => {
                  await teamApi.removeMember(team.id, me?.id ?? '')
                  await reloadTeams()
                  navigate(`/day/${todayISO()}`, { replace: true })
                }}
              />
            )}
          </div>
        )}
      </main>
      <BottomTabs view="other" date={todayISO()} />
    </div>
  )
}
