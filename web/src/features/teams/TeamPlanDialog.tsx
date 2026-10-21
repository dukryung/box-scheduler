import { useEffect, useRef, useState } from 'react'
import { teamApi } from '../../api/client'
import type { PlanSub, TeamPlan, TeamTask } from '../../api/types'
import { AIError } from '../../components/AIError'
import { Close, Sparkle } from '../../components/icons'
import { aiButton, aiOutlineButton, secondaryButton } from '../../components/styles'
import { WEEKDAYS, parseISODate, todayISO } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { useAIQueue } from '../../lib/useAIQueue'

interface Props {
  teamId: string
  task: TeamTask
  onClose: () => void
  onApplied: (task: TeamTask, message: string) => void
}

type Row = PlanSub & { key: number }

const nowHM = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const dayLabel = (iso: string) => {
  const d = parseISODate(iso)
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`
}
const hours = (boxes: number) => String(Math.round((boxes / 6) * 100) / 100)
let nextKey = 1

/**
 * "AI로 업무 나누기": the whole team task is split once into subtasks, each given
 * to one of its people (proposed to fit their shares); confirming puts each
 * person's subtasks into their own Brain Dump over their working days.
 */
export function TeamPlanDialog({ teamId, task, onClose, onApplied }: Props) {
  const editable = task.subtasks.filter((x) => !x.started)
  const [rows, setRows] = useState<Row[]>(() => editable.map((x) => ({ title: x.title, boxes: x.boxes, assigneeId: x.assigneeId, key: nextKey++ })))
  const [plan, setPlan] = useState<TeamPlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abort = useRef<AbortController | null>(null)
  const skipPreview = useRef(false)
  const waiting = useAIQueue(loading)
  const today = todayISO()
  const subs = rows.filter((r) => r.title.trim() && r.boxes > 0).map(({ title, boxes, assigneeId }) => ({ title, boxes, assigneeId }))
  const body = () => ({ today, now: nowHM(), subtasks: subs })

  const suggest = async () => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const p = await teamApi.plan(teamId, task.id, { today, now: nowHM() }, ctrl.signal)
      skipPreview.current = true
      setPlan(p)
      setRows(p.subtasks.map((x) => ({ ...x, key: nextKey++ })))
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message)
    }
    if (!ctrl.signal.aborted) setLoading(false)
  }

  // On open: ask the AI when there is nothing to edit yet, else show the current split.
  useEffect(() => {
    if (editable.length === 0) void suggest()
    return () => abort.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-spread after every edit (no AI involved).
  const key = JSON.stringify(subs)
  useEffect(() => {
    if (skipPreview.current) {
      skipPreview.current = false
      return
    }
    if (loading) return
    const t = setTimeout(() => {
      teamApi.planPreview(teamId, task.id, body()).then(
        (p) => setPlan((prev) => ({ ...p, notes: prev?.notes })),
        (e: Error) => setError(e.message),
      )
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const name = (userId: string) => {
    const a = task.assignees.find((x) => x.userId === userId)
    return a ? a.name || a.email.split('@')[0] : '담당자 없음'
  }

  const apply = async () => {
    setSaving(true)
    setError(null)
    try {
      const r = await teamApi.planApply(teamId, task.id, body())
      const people = r.people.filter((p) => p.new > 0)
      onApplied(r.task, `하위 업무 ${subs.length}개를 나눠 ${people.map((p) => p.name).join(', ')}의 Brain Dump에 넣었어요`)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-[rgba(21,23,28,0.42)] md:items-center md:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section role="dialog" aria-label="업무 나누기" className="flex max-h-dvh w-full flex-col overflow-hidden bg-surface md:max-h-[90dvh] md:max-w-3xl md:rounded-2xl md:border md:border-line md:shadow-xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3 md:px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ai-soft text-ai">
            <Sparkle size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">업무 나누기</h2>
            <p className="truncate text-xs text-muted">
              {task.title}
              {task.estimateBoxes ? ` · 예상 ${formatDuration(task.estimateBoxes)}` : ''} · 담당 {task.assignees.map((a) => a.name || a.email.split('@')[0]).join(', ')}
            </p>
          </div>
          <button onClick={onClose} aria-label="닫기" className="rounded-lg p-2 text-muted hover:bg-subtle">
            <Close size={18} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-5">
          {loading && (
            <div role="status" className="flex items-center gap-2.5 rounded-xl bg-ai-soft px-3.5 py-3 text-sm text-ai-ink">
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ai border-t-transparent" />
              {waiting > 0 ? `AI 대기 중이에요 · 앞에 ${waiting}건` : 'AI가 업무 전체를 나누고 담당자를 정하고 있어요… 로컬 AI는 1분 넘게 걸릴 수 있어요.'}
            </div>
          )}
          {error && <AIError error={error} />}

          {plan && (
            <p className="text-xs leading-relaxed text-muted">
              기간 {dayLabel(plan.period.from)} ~ {dayLabel(plan.period.to)} · 근무일 {plan.period.workingDays}일 · 한 사람이 이 업무에 하루 최대 {formatDuration(plan.policy.perTaskMax)} · 각자 비어 있는 근무
              시간({plan.policy.workStart}–{plan.policy.workEnd}, 점심 제외)에 나눠 넣어요
            </p>
          )}

          {(plan?.kept.length ?? 0) > 0 && (
            <section aria-label="진행 중인 하위 업무" className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold text-ink-2">이미 시작한 하위 업무 · 그대로 둬요</h3>
              <ul className="flex flex-col gap-1">
                {plan!.kept.map((x) => (
                  <li key={x.id} className="flex items-center gap-2 rounded-xl bg-subtle px-3 py-2 text-sm text-ink-2">
                    <span className="min-w-0 flex-1 truncate">{x.title}</span>
                    <span className="font-mono text-xs">{formatDuration(x.boxes)}</span>
                    <span className="text-xs">{name(x.assigneeId)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-label="하위 업무" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink-2">하위 업무와 담당자</h3>
              <button className={`${aiOutlineButton} h-8 px-3 text-xs`} disabled={loading} onClick={() => void suggest()}>
                <Sparkle size={13} /> {rows.length ? 'AI 추천 다시 받기' : 'AI 추천 받기'}
              </button>
            </div>
            {!loading && rows.length === 0 && <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-muted">하위 업무가 없어요. AI 추천을 받거나 직접 추가해 주세요.</p>}
            <ul className="flex flex-col gap-1.5">
              {rows.map((r, i) => (
                <li key={r.key} aria-label={r.title || `하위 업무 ${i + 1}`} className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={r.title}
                      onChange={(e) => setRow(i, { title: e.target.value })}
                      aria-label="하위 업무 이름"
                      maxLength={80}
                      className="min-w-[160px] flex-1 rounded-md bg-transparent px-1 py-1 text-sm font-medium outline-none focus:bg-subtle"
                    />
                    <label className="flex items-center gap-1 text-xs text-muted">
                      <input
                        type="number"
                        inputMode="decimal"
                        min={0.5}
                        step={0.5}
                        aria-label={`${r.title} 시간`}
                        value={hours(r.boxes)}
                        onChange={(e) => setRow(i, { boxes: Math.max(1, Math.round(Number(e.target.value) * 6) || 1) })}
                        className="h-8 w-16 rounded-md border border-line-strong bg-surface px-2 text-right font-mono text-sm text-ink"
                      />
                      시간
                    </label>
                    <select aria-label={`${r.title} 담당자`} value={r.assigneeId} onChange={(e) => setRow(i, { assigneeId: e.target.value })} className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm">
                      {task.assignees.map((a) => (
                        <option key={a.userId} value={a.userId}>
                          {a.name || a.email.split('@')[0]}
                        </option>
                      ))}
                      <option value="">담당자 없음</option>
                    </select>
                    <button aria-label={`${r.title} 빼기`} onClick={() => setRows(rows.filter((_, j) => j !== i))} className="h-8 w-8 rounded-md text-muted hover:bg-subtle hover:text-ink">
                      ×
                    </button>
                  </div>
                  {r.reason && <span className="px-1 text-[11px] text-muted">{r.reason}</span>}
                </li>
              ))}
            </ul>
            <button
              className="self-start text-sm font-medium text-ai-ink"
              onClick={() => setRows([...rows, { title: '새 하위 업무', boxes: 6, assigneeId: task.assignees[0]?.userId ?? '', key: nextKey++ }])}
            >
              + 직접 추가
            </button>
          </section>

          {plan?.notes && <p className="rounded-xl bg-ai-soft px-3.5 py-2.5 text-sm leading-relaxed text-ai-ink">💬 {plan.notes}</p>}

          {plan && (
            <section aria-label="사람별 배정" className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-ink-2">사람별 배정</h3>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {plan.people.map((p) => {
                  const total = p.kept + p.new
                  const off = p.share > 0 && total !== p.share
                  return (
                    <li key={p.userId} aria-label={p.name} className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2 text-sm">
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">{p.name}</span>
                        <span className={`font-mono text-xs ${off ? 'font-semibold text-ink' : 'text-muted'}`}>
                          {formatDuration(total)}
                          {p.share > 0 && ` / 맡은 ${formatDuration(p.share)}`}
                        </span>
                      </span>
                      <span className="text-xs text-muted">
                        {p.new > 0 ? `${dayLabel(p.from)} ~ ${dayLabel(p.to)} · ${p.days}일에 나눠 넣어요` : '이번에 새로 맡는 일이 없어요'}
                        {p.kept > 0 && ` · 진행 중 ${formatDuration(p.kept)}`}
                      </span>
                      {p.shortage > 0 && <span className="text-xs font-semibold text-danger">{formatDuration(p.shortage)}은 마감 전에 시간이 모자라요</span>}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 pb-[max(env(safe-area-inset-bottom),12px)] md:px-5">
          <span className="text-xs text-muted">
            {subs.length > 0 && `하위 업무 ${subs.length}개 · ${formatDuration(subs.reduce((n, s) => n + s.boxes, 0))}`}
            {editable.length > 0 && ' · 시작 안 한 기존 하위 업무는 바뀌어요'}
          </span>
          <button className={`${secondaryButton} ml-auto h-10`} onClick={onClose}>
            취소
          </button>
          <button className={`${aiButton} h-10`} disabled={saving || loading || subs.length === 0 || !plan} onClick={() => void apply()}>
            {saving ? '넣는 중…' : '확정하고 각자 Brain Dump에 넣기'}
          </button>
        </footer>
      </section>
    </div>
  )
}
