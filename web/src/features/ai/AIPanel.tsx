import { useState } from 'react'
import { SLOTS_PER_DAY, formatDuration, slotToTime } from '../../lib/slots'
import type { AISuggestionState } from './useAISuggestion'

const STEP = 3 // 30-minute choices
const DEFAULT_FROM = 54 // 09:00
const DEFAULT_TO = 132 // 22:00

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
  onApplied: (count: number) => void
}

export function AIPanel({ ai, nowSlot, onClose, onApplied }: Props) {
  const [range, setRange] = useState(() => defaultRange(nowSlot))
  const { status, suggestion, error } = ai
  const busy = status === 'loading' || status === 'applying'

  const timeSelect = (value: number, onChange: (v: number) => void, label: string, valid: (v: number) => boolean) => (
    <select
      aria-label={label}
      value={value}
      disabled={busy}
      onChange={(e) => onChange(Number(e.target.value))}
      className="rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-sm tabular-nums dark:border-zinc-700"
    >
      {options.filter(valid).map((s) => (
        <option key={s} value={s}>
          {slotToTime(s)}
        </option>
      ))}
    </select>
  )

  return (
    <section className="flex h-full flex-col gap-3 p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">✨ AI 일정 제안</h2>
        <button onClick={onClose} className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
          닫기
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {timeSelect(range.from, (from) => setRange((r) => ({ ...r, from })), '시작 시각', (s) => s < range.to)}
        <span>부터</span>
        {timeSelect(range.to, (to) => setRange((r) => ({ ...r, to })), '끝 시각', (s) => s > range.from)}
        <span>사이에</span>
        <button
          onClick={() => void ai.request(range.from, range.to)}
          disabled={busy}
          className="rounded-md bg-violet-600 px-3 py-1 text-white hover:bg-violet-500 disabled:opacity-40"
        >
          {suggestion ? '다시 제안' : '제안 받기'}
        </button>
      </div>
      <p className="text-xs text-zinc-500">Brain Dump에 남은 일을 Claude가 쪼개고, 빈 시간에 배치해 볼게요. 적용 전까지는 저장되지 않아요.</p>

      {status === 'loading' && (
        <div role="status" className="flex items-center gap-2 rounded-md bg-violet-50 px-3 py-2 text-sm text-violet-800 dark:bg-violet-950 dark:text-violet-200">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
          Claude가 하루를 짜고 있어요… 보통 10~30초 걸려요.
          <button onClick={ai.cancel} className="ml-auto underline">
            취소
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {suggestion && (
        <>
          {suggestion.notes && (
            <p className="rounded-md bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-900">{suggestion.notes}</p>
          )}
          <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto" aria-label="제안된 블록">
            {suggestion.blocks.length === 0 && <li className="px-1 text-sm text-zinc-500">빈 시간에 넣을 수 있는 일이 없어요.</li>}
            {suggestion.blocks.map((b) => {
              const key = ai.blockKey(b)
              return (
                <li
                  key={key}
                  onMouseEnter={() => ai.setHovered(key)}
                  onMouseLeave={() => ai.setHovered(null)}
                  className={`rounded-md px-2 py-1.5 ${ai.hovered === key ? 'bg-violet-50 dark:bg-violet-950' : ''}`}
                >
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={ai.isAccepted(b)}
                      disabled={busy}
                      onChange={() => ai.toggle(b)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-xs text-zinc-500 tabular-nums">
                        {slotToTime(b.startSlot)}–{slotToTime(b.endSlot)}
                      </span>{' '}
                      <span className={ai.isAccepted(b) ? '' : 'text-zinc-400 line-through'}>{b.title}</span>
                      {b.reason && <span className="mt-0.5 block text-xs text-zinc-500">{b.reason}</span>}
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>

          {suggestion.unplaced.length > 0 && (
            <div className="text-xs text-zinc-500">
              <div className="font-medium">시간이 부족해 넣지 못한 일</div>
              <ul className="mt-1 list-disc pl-4">
                {suggestion.unplaced.map((u, i) => (
                  <li key={`${u.taskId}-${i}`}>
                    {u.title} ({formatDuration(u.boxes)})
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            onClick={async () => {
              const count = await ai.apply()
              if (count !== null) onApplied(count)
            }}
            disabled={busy || ai.accepted.length === 0}
            className="rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
          >
            {status === 'applying' ? '적용하는 중…' : `${ai.accepted.length}개 블록 적용`}
          </button>
        </>
      )}
    </section>
  )
}
