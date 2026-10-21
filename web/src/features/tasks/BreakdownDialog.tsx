import { useEffect, useRef, useState } from 'react'
import { breakdownApi } from '../../api/client'
import type { BacklogItem, BreakdownPreview, BreakdownSub } from '../../api/types'
import { AIError } from '../../components/AIError'
import { Close, Sparkle } from '../../components/icons'
import { aiButton, aiOutlineButton, secondaryButton } from '../../components/styles'
import { WEEKDAYS, parseISODate } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { useAIQueue } from '../../lib/useAIQueue'

interface Props {
  item: BacklogItem
  today: string
  onClose: () => void
  onApplied: (message: string) => void
}

type Row = BreakdownSub & { on: boolean; reason?: string }

const nowHM = () => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const dayLabel = (iso: string) => {
  const d = parseISODate(iso)
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})`
}

/**
 * "AI로 세분화": the AI suggests the pieces; the server spreads them over working
 * days; the person edits, then adds each day's share to that day's Brain Dump.
 */
export function BreakdownDialog({ item, today, onClose, onApplied }: Props) {
  const [due, setDue] = useState(item.dueDate ?? '')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<BreakdownPreview | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [replace, setReplace] = useState(true)
  const abort = useRef<AbortController | null>(null)
  const waiting = useAIQueue(loading)
  const body = (subs?: BreakdownSub[]) => ({ today, now: nowHM(), dueDate: item.dueDate ? undefined : due, subtasks: subs })

  const suggest = async () => {
    abort.current?.abort()
    const ctrl = new AbortController()
    abort.current = ctrl
    setLoading(true)
    setError(null)
    try {
      const p = await breakdownApi.suggest(item.id, body(), ctrl.signal)
      setPreview(p)
      setRows(p.subtasks.map((s, i) => ({ ...s, on: true, reason: p.reasons?.[i] })))
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message)
    }
    if (!ctrl.signal.aborted) setLoading(false)
  }

  useEffect(() => {
    if (item.dueDate) void suggest()
    return () => abort.current?.abort()
    // Ask once on open when the period is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-spread after every edit (no AI involved).
  const included = rows.filter((r) => r.on && r.title.trim() && r.boxes > 0).map(({ title, boxes }) => ({ title, boxes }))
  const key = JSON.stringify(included)
  const firstKey = useRef('')
  useEffect(() => {
    if (!preview) return
    if (!firstKey.current) {
      firstKey.current = key
      return
    }
    const t = setTimeout(() => {
      breakdownApi.allocate(item.id, body(included)).then(
        (p) => setPreview((prev) => (prev ? { ...prev, plan: p.plan } : prev)),
        (e: Error) => setError(e.message),
      )
    }, 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, d: -1 | 1) => {
    const next = [...rows]
    ;[next[i], next[i + d]] = [next[i + d], next[i]]
    setRows(next)
  }

  const plan = preview?.plan
  const usedDays = plan?.days.filter((d) => d.total > 0) ?? []
  const pieceCount = usedDays.reduce((n, d) => n + d.pieces.length, 0)

  const apply = async () => {
    setSaving(true)
    setError(null)
    try {
      const r = await breakdownApi.apply(item.id, { ...body(included), replace })
      onApplied(`‘${item.title}’을(를) ${usedDays.length}일에 ${r.created}개로 나눠 Brain Dump에 넣었어요${r.shortage ? ` · ${formatDuration(r.shortage)}은 기간 안에 못 넣었어요` : ''}`)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-[rgba(21,23,28,0.42)] md:items-center md:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        role="dialog"
        aria-label="AI 세분화"
        className="flex max-h-dvh w-full flex-col overflow-hidden bg-surface md:max-h-[90dvh] md:max-w-3xl md:rounded-2xl md:border md:border-line md:shadow-xl"
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3 md:px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-ai-soft text-ai">
            <Sparkle size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">AI 세분화</h2>
            <p className="truncate text-xs text-muted">{item.title}</p>
          </div>
          <button onClick={onClose} aria-label="닫기" className="rounded-lg p-2 text-muted hover:bg-subtle">
            <Close size={18} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-5">
          {!item.dueDate && !preview && (
            <div className="flex flex-col gap-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                언제까지 끝낼까요? (마감일)
                <input type="date" min={today} value={due} onChange={(e) => setDue(e.target.value)} className="h-11 rounded-[10px] border border-line-strong bg-surface px-3 text-sm text-ink" />
              </label>
              <button className={`${aiButton} h-11 self-start`} disabled={!due || loading} onClick={() => void suggest()}>
                <Sparkle size={16} /> AI에게 세분화 추천 받기
              </button>
            </div>
          )}

          {loading && (
            <div role="status" className="flex items-center gap-2.5 rounded-xl bg-ai-soft px-3.5 py-3 text-sm text-ai-ink">
              <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ai border-t-transparent" />
              {waiting > 0 ? `AI 대기 중이에요 · 앞에 ${waiting}건` : 'AI가 할 일을 나누고 있어요… 로컬 AI는 1분 넘게 걸릴 수 있어요.'}
            </div>
          )}
          {error && <AIError error={error} />}

          {preview && plan && (
            <>
              <p className="text-xs leading-relaxed text-muted">
                기간 {dayLabel(preview.period.from)} ~ {dayLabel(preview.period.to)} · 근무일 {preview.period.workingDays}일 · 근무 {preview.policy.workStart}–{preview.policy.workEnd} (점심{' '}
                {preview.policy.lunchStart}–{preview.policy.lunchEnd} 제외, 하루 {formatDuration(preview.policy.capacity)}) · 이 일은 하루 최대 {formatDuration(preview.policy.perTaskMax)}
              </p>

              <section aria-label="하위 업무" className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink-2">나눈 일 · 순서대로 진행해요</h3>
                <ul className="flex flex-col gap-1.5">
                  {rows.map((r, i) => (
                    <li key={i} className={`flex flex-col gap-1 rounded-xl border px-3 py-2 ${r.on ? 'border-line' : 'border-dashed border-line opacity-55'}`}>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" checked={r.on} onChange={(e) => setRow(i, { on: e.target.checked })} aria-label={`${r.title} 포함`} className="h-[18px] w-[18px] shrink-0 accent-[var(--app-ai)]" />
                        <input
                          value={r.title}
                          onChange={(e) => setRow(i, { title: e.target.value })}
                          aria-label="나눈 일 이름"
                          className="min-w-0 flex-1 rounded-md bg-transparent px-1 py-1 text-sm font-medium outline-none focus:bg-subtle"
                        />
                        <span className="flex shrink-0 items-center rounded-md bg-subtle text-xs">
                          <button aria-label="10분 줄이기" disabled={r.boxes <= 1} onClick={() => setRow(i, { boxes: r.boxes - 1 })} className="h-7 w-7 rounded-md hover:bg-line disabled:opacity-30">
                            −
                          </button>
                          <span className="w-16 text-center font-mono">{formatDuration(r.boxes)}</span>
                          <button aria-label="10분 늘리기" onClick={() => setRow(i, { boxes: r.boxes + 1 })} className="h-7 w-7 rounded-md hover:bg-line">
                            +
                          </button>
                        </span>
                        <span className="flex shrink-0 flex-col">
                          <button aria-label="위로" disabled={i === 0} onClick={() => move(i, -1)} className="px-1 text-[10px] leading-3 text-muted disabled:opacity-20">
                            ▲
                          </button>
                          <button aria-label="아래로" disabled={i === rows.length - 1} onClick={() => move(i, 1)} className="px-1 text-[10px] leading-3 text-muted disabled:opacity-20">
                            ▼
                          </button>
                        </span>
                      </div>
                      {r.reason && <span className="pl-7 text-[11px] text-muted">{r.reason}</span>}
                    </li>
                  ))}
                </ul>
                <button className="self-start text-sm font-medium text-ai-ink" onClick={() => setRows([...rows, { title: '새 일', boxes: 6, on: true }])}>
                  + 직접 추가
                </button>
              </section>

              {preview.notes && <p className="rounded-xl bg-ai-soft px-3.5 py-2.5 text-sm leading-relaxed text-ai-ink">💬 {preview.notes}</p>}

              <section aria-label="날짜별 배분" className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-ink-2">날짜별 배분</h3>
                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {plan.days.map((d) => (
                    <li key={d.date} className={`flex flex-col gap-1 rounded-xl border px-3 py-2 text-sm ${d.total ? 'border-line' : 'border-line opacity-50'}`}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-medium">{dayLabel(d.date)}</span>
                        <span className="font-mono text-xs text-muted">
                          {d.reserve && <span className="mr-1 rounded bg-subtle px-1 font-sans">여유</span>}
                          {d.total ? formatDuration(d.total) : '–'} <span className="text-faint">/ 빈 시간 {formatDuration(d.free)}</span>
                        </span>
                      </span>
                      {d.pieces.map((p, k) => (
                        <span key={k} className="flex justify-between gap-2 text-xs text-ink-2">
                          <span className="truncate">{p.title}</span>
                          <span className="shrink-0 font-mono">{formatDuration(p.boxes)}</span>
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </section>

              <p className={`text-sm ${plan.shortage ? 'text-danger' : 'text-ink-2'}`} role="status">
                합계 {formatDuration(plan.total)} · 기간 안에 {formatDuration(plan.placed)}
                {plan.shortage > 0 && ` · ${formatDuration(plan.shortage)} 부족해요. 마감을 늦추거나 시간을 줄여 보세요.`}
              </p>
              {preview.existing > 0 && (
                <label className="flex items-center gap-2 text-sm text-ink-2">
                  <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="h-4 w-4" />
                  전에 나눠 둔 일 {preview.existing}개(아직 시간표에 없는 것)를 이번 것으로 바꾸기
                </label>
              )}
            </>
          )}
        </div>

        {preview && (
          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 md:px-5">
            <button className={`${aiOutlineButton} h-10`} disabled={loading || saving} onClick={() => void suggest()}>
              다시 추천
            </button>
            <button className={`${secondaryButton} h-10`} onClick={onClose}>
              취소
            </button>
            <button className={`${aiButton} h-10`} disabled={saving || loading || pieceCount === 0} onClick={() => void apply()}>
              {saving ? '넣는 중…' : `확인하고 Brain Dump에 추가 (${usedDays.length}일, ${pieceCount}개)`}
            </button>
          </footer>
        )}
      </section>
    </div>
  )
}
