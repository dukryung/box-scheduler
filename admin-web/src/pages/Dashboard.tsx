import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api, type AuditEntry, type Dashboard as Data, type DayPoint } from '../api'
import { ACTION_LABEL, dateTimeText } from '../format'
import { Card, ErrorText, PageHeader, Stat } from '../ui'

/** One series of daily counts as thin columns; hover shows the day and value. */
function DailyBars({ days, pick, label }: { days: DayPoint[]; pick: (d: DayPoint) => number; label: string }) {
  const max = Math.max(1, ...days.map(pick))
  const total = days.reduce((n, d) => n + pick(d), 0)
  return (
    <figure className="flex flex-col gap-2 px-4 pt-3 pb-4" aria-label={`${label}, 최근 30일 합계 ${total}`}>
      <div className="flex h-28 items-end gap-[3px] border-b border-line">
        {days.map((d) => {
          const v = pick(d)
          return (
            <div key={d.day} title={`${d.day.slice(5).replace('-', '/')} · ${v}`} className="group flex h-full flex-1 items-end">
              <div className="w-full rounded-t-[3px] bg-accent-bright group-hover:bg-accent" style={{ height: v ? `${Math.max(4, (v / max) * 100)}%` : 0 }} />
            </div>
          )
        })}
      </div>
      <figcaption className="flex justify-between font-mono text-[11px] text-faint">
        <span>{days[0]?.day.slice(5).replace('-', '/')}</span>
        <span>
          30일 합계 <span className="text-ink-2">{total}</span> · 하루 최대 {max}
        </span>
        <span>{days[days.length - 1]?.day.slice(5).replace('-', '/')}</span>
      </figcaption>
    </figure>
  )
}

export function Dashboard() {
  const [data, setData] = useState<Data | null>(null)
  const [recent, setRecent] = useState<AuditEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    Promise.all([api.dashboard(), api.audit({ limit: 8 })]).then(
      ([d, a]) => {
        setData(d)
        setRecent(a.entries)
      },
      (e: Error) => setError(e.message),
    )
  }, [])

  return (
    <>
      <PageHeader title="대시보드" />
      <ErrorText error={error} />
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <Stat label="전체 사용자" value={data.users} />
            <Stat label="최근 7일 활동" value={data.active7d} hint="하루라도 앱을 쓴 사람" />
            <Stat label="최근 7일 가입" value={data.signups7d} />
            <Stat label="Google 연결" value={data.google} />
            <Stat label="정지" value={data.suspended} />
            <Stat label="AI 사용 (7일)" value={`${data.aiCalls7d}회`} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="하루 활동 사용자">
              <DailyBars days={data.days} pick={(d) => d.active} label="하루 활동 사용자" />
            </Card>
            <Card title="하루 가입">
              <DailyBars days={data.days} pick={(d) => d.signups} label="하루 가입" />
            </Card>
            <Card title="하루 AI 사용">
              <DailyBars days={data.days} pick={(d) => d.aiCalls} label="하루 AI 사용" />
            </Card>
          </div>
        </>
      )}
      <Card
        title="최근 관리 기록"
        aside={
          <Link to="/audit" className="text-xs font-semibold text-accent dark:text-accent-bright">
            전체 보기
          </Link>
        }
      >
        {recent.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">아직 기록이 없어요.</p>
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
                <span className="w-32 shrink-0 font-mono text-xs text-muted">{dateTimeText(e.createdAt)}</span>
                <span className="font-medium">{ACTION_LABEL[e.action] ?? e.action}</span>
                <span className="text-ink-2">{e.target}</span>
                <span className="ml-auto text-xs text-muted">{e.actor}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  )
}
