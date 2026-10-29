import { useState, type FormEvent } from 'react'
import { Close, Sparkle } from '../../components/icons'
import { aiButton, aiOutlineButton } from '../../components/styles'
import { SLOTS_PER_DAY, formatDuration, slotToTime } from '../../lib/slots'
import type { AppliedPlan } from '../../api/types'
import type { BlockChange } from '../../lib/suggestionDiff'
import type { AISuggestionState } from './useAISuggestion'
import { AIError } from '../../components/AIError'
import { useAIQueue } from '../../lib/useAIQueue'

const STEP = 3 // 30-minute choices
const DEFAULT_FROM = 54 // 09:00
const DEFAULT_TO = 132 // 22:00

const breakChoices = [0, 10, 20, 30]

const options = Array.from({ length: SLOTS_PER_DAY / STEP + 1 }, (_, i) => i * STEP)

/** Today plans from the next half hour; other days from 09:00. */
function defaultRange(nowSlot: number | null) {
  const from = nowSlot === null ? DEFAULT_FROM : Math.min(Math.ceil((nowSlot + 1) / STEP) * STEP, SLOTS_PER_DAY - STEP)
  return { from, to: Math.max(DEFAULT_TO, Math.min(from + 12, SLOTS_PER_DAY)) }
}

interface Props {
  ai: AISuggestionState
  nowSlot: number | null
  onClose: () => void
  onApplied: (applied: AppliedPlan) => void
}

const changeLabel: Record<BlockChange, string> = { new: '새로 넣음', moved: '옮김', resized: '길이 바뀜' }

export function AIPanel({ ai, nowSlot, onClose, onApplied }: Props) {
  const [range, setRange] = useState(() => defaultRange(nowSlot))
  const [includeBacklog, setIncludeBacklog] = useState(false)
  const { status, suggestion, error } = ai
  const busy = status === 'loading' || status === 'revising' || status === 'applying'
  const waiting = useAIQueue(status === 'loading' || status === 'revising')
  const [change, setChange] = useState('')

  const submitChange = async (e: FormEvent) => {
    e.preventDefault()
    if (await ai.revise(change)) setChange('')
  }

  const timeSelect = (label: string, value: number, onChange: (v: number) => void, valid: (v: number) => boolean) => (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <select
        aria-label={`${label} 시각`}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-10 rounded-[10px] border border-line-strong bg-surface px-2.5 font-mono text-sm text-ink"
      >
        {options.filter(valid).map((s) => (
          <option key={s} value={s}>
            {slotToTime(s)}
          </option>
        ))}
      </select>
    </label>
  )

  return (
    <section className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex items-center gap-2">
        <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] bg-ai-soft text-ai">
          <Sparkle size={16} />
        </span>
        <h2 className="text-base font-bold">AI 일정 제안</h2>
        <button onClick={onClose} aria-label="닫기" className="ml-auto flex h-9 w-9 items-center justify-center rounded-lg text-muted hover:bg-subtle">
          <Close size={16} />
        </button>
      </header>

      <div className="flex items-end gap-2">
        {timeSelect('시작', range.from, (from) => setRange((r) => ({ ...r, from })), (s) => s < range.to)}
        {timeSelect('끝', range.to, (to) => setRange((r) => ({ ...r, to })), (s) => s > range.from)}
        <button onClick={() => void ai.request(range.from, range.to, includeBacklog)} disabled={busy} className={`${suggestion ? aiOutlineButton : aiButton} ml-auto h-10`}>
          {suggestion ? '다시 제안' : '제안 받기'}
        </button>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink-2">
        <input
          type="checkbox"
          checked={includeBacklog}
          disabled={busy}
          onChange={(e) => setIncludeBacklog(e.target.checked)}
          className="h-4 w-4 accent-[var(--app-ai)]"
        />
        보관함에서 마감이 가깝거나 중요한 일도 함께 넣기
      </label>
      <label className="flex items-center gap-2 text-[13px] text-ink-2">
        블록 사이 쉬는 시간
        <select
          aria-label="블록 사이 쉬는 시간"
          value={ai.breakMinutes}
          disabled={busy}
          onChange={(e) => void ai.chooseBreak(Number(e.target.value))}
          className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px] text-ink"
        >
          {breakChoices.map((m) => (
            <option key={m} value={m}>
              {m === 0 ? '없음' : `${m}분`}
            </option>
          ))}
        </select>
      </label>
      {!suggestion && status !== 'loading' && (
        <p className="text-[13px] leading-relaxed text-muted">
          Brain Dump에 남은 일을 AI가 쪼개고 빈 시간에 배치해요. 제안을 받은 뒤 고칠 점을 적어 다시 짜게 할 수 있고, 적용하기 전까지는 시간표에 저장되지 않아요.
        </p>
      )}

      {(status === 'loading' || status === 'revising') && (
        <div role="status" className="flex items-center gap-2.5 rounded-xl bg-ai-soft px-3.5 py-3 text-sm text-ai-ink">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ai border-t-transparent" />
          {waiting > 0
            ? `AI 대기 중이에요 · 앞에 ${waiting}건`
            : status === 'revising'
              ? 'AI가 요청대로 고치고 있어요…'
              : 'AI가 하루를 짜고 있어요… 보통 10~30초 걸려요.'}
          <button onClick={ai.cancel} className="ml-auto font-medium underline">
            취소
          </button>
        </div>
      )}
      {error && <AIError error={error} />}

      {suggestion && (
        <>
          {suggestion.notes && <p className="rounded-xl bg-ai-soft px-3.5 py-3 text-[13px] leading-relaxed text-ai-ink">{suggestion.notes}</p>}
          {suggestion.breakMinutes > 0 && <p className="text-xs text-muted">블록 사이에 {suggestion.breakMinutes}분씩 쉬는 시간을 뒀어요</p>}
          <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1" aria-label="제안된 블록">
            {suggestion.blocks.length === 0 && <li className="text-sm text-muted">빈 시간에 넣을 수 있는 일이 없어요.</li>}
            {suggestion.blocks.map((b, i) => {
              const key = ai.blockKey(b)
              const on = ai.isAccepted(b)
              const changed = ai.diff?.changes[i]
              return (
                <li key={key} onMouseEnter={() => ai.setHovered(key)} onMouseLeave={() => ai.setHovered(null)}>
                  <label
                    className={`flex cursor-pointer gap-2.5 rounded-xl border p-3 ${on ? 'border-ai-line bg-ai-soft/40' : 'border-line bg-surface'} ${
                      ai.hovered === key ? 'ring-2 ring-ai/40' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-[18px] w-[18px] shrink-0 accent-[var(--app-ai)]"
                      checked={on}
                      disabled={busy}
                      onChange={() => ai.toggle(b)}
                    />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-mono text-xs text-ai">
                          {slotToTime(b.startSlot)}–{slotToTime(b.endSlot)}
                        </span>
                        <span className={`text-sm font-semibold ${on ? '' : 'text-faint line-through'}`}>{b.title}</span>
                        {changed && <span className="rounded-md bg-ai/10 px-1.5 py-0.5 text-[11px] font-semibold text-ai">{changeLabel[changed]}</span>}
                      </span>
                      {b.shifted && <span className="text-xs text-ai-ink">요청한 시간이 차 있어서 가장 가까운 빈 시간에 넣었어요</span>}
                      {b.reason && <span className="text-xs leading-relaxed text-muted">{b.reason}</span>}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>

          {ai.diff && ai.diff.removed.length > 0 && (
            <div className="text-xs text-muted">
              <div className="font-semibold text-ink-2">이번 수정에서 뺀 일</div>
              <ul aria-label="뺀 블록" className="mt-1 list-disc pl-4">
                {ai.diff.removed.map((r) => (
                  <li key={ai.blockKey(r)}>
                    {r.title} ({slotToTime(r.startSlot)}–{slotToTime(r.endSlot)})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {suggestion.unplaced.length > 0 && (
            <div className="text-xs text-muted">
              <div className="font-semibold text-ink-2">시간이 부족해 넣지 못한 일</div>
              <ul className="mt-1 list-disc pl-4">
                {suggestion.unplaced.map((u, i) => (
                  <li key={`${u.taskId}-${i}`}>
                    {u.title} ({formatDuration(u.boxes)})
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Stays visible at the bottom of the phone sheet while the list scrolls. */}
          <div className="sticky bottom-0 -mx-1 flex flex-col gap-1.5 bg-surface px-1 pt-2">
            {ai.requests.length > 0 && (
              <ol aria-label="수정 요청 기록" className="flex flex-wrap gap-1.5">
                {ai.requests.map((r, i) => (
                  <li key={i} className="max-w-full truncate rounded-full bg-subtle px-2.5 py-1 text-xs text-ink-2">
                    {r}
                  </li>
                ))}
              </ol>
            )}
            <form onSubmit={submitChange} className="flex gap-2">
              <input
                value={change}
                onChange={(e) => setChange(e.target.value)}
                disabled={busy}
                maxLength={300}
                aria-label="제안 수정 요청"
                placeholder="예: 운동은 저녁 8시로, 메일은 빼줘"
                className="h-11 min-w-0 flex-1 rounded-[10px] border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-faint"
              />
              <button type="submit" disabled={busy || !change.trim()} className={`${aiOutlineButton} h-11 shrink-0`}>
                고치기
              </button>
            </form>
            <button
              onClick={async () => {
                const applied = await ai.apply()
                if (applied) onApplied(applied)
              }}
              disabled={busy || ai.accepted.length === 0}
              className={`${aiButton} h-12 text-[15px]`}
            >
              {status === 'applying' ? '적용하는 중…' : `${ai.accepted.length}개 블록 적용`}
            </button>
            <span className="text-center text-xs text-muted">적용 전까지는 시간표에 저장되지 않아요</span>
          </div>
        </>
      )}
    </section>
  )
}
