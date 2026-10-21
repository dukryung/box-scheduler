import { useState } from 'react'
import { useNavigate } from 'react-router'
import { teamApi } from '../../api/client'
import { card, primaryButton } from '../../components/styles'
import { todayISO } from '../../lib/date'
import { useTeams } from '../../store/teamsStore'
import { BottomTabs, TopBar, ViewSwitch } from '../nav/ViewSwitch'

export function NewTeamPage() {
  const navigate = useNavigate()
  const reload = useTeams((s) => s.load)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <TopBar phoneTheme>
        <h1 className="flex-1 text-center text-[17px] font-semibold md:flex-none md:pl-2 md:text-left md:text-lg">새 팀</h1>
        <div className="ml-auto hidden md:block">
          <ViewSwitch view="other" date={todayISO()} />
        </div>
      </TopBar>
      <main className="mx-auto w-full max-w-[520px] px-4 pt-6">
        <form
          className={`${card} flex flex-col gap-3 p-5`}
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            try {
              const t = await teamApi.create(name)
              await reload()
              navigate(`/team/${t.id}?invite=1`)
            } catch (err) {
              setError((err as Error).message)
              setBusy(false)
            }
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            팀 이름
            <input
              required
              autoFocus
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="예: 개발팀"
              className="h-11 rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent md:text-sm"
            />
          </label>
          <p className="text-xs text-muted">만든 사람이 owner가 돼요. 다음 화면에서 이메일로 멤버를 초대할 수 있어요.</p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <button className={`${primaryButton} h-11 self-start`} disabled={busy || !name.trim()}>
            팀 만들기
          </button>
        </form>
      </main>
      <BottomTabs view="other" date={todayISO()} />
    </div>
  )
}
