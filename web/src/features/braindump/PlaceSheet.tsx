import { useEffect, useState } from 'react'
import type { Block } from '../../api/types'
import { Sparkle } from '../../components/icons'
import { aiOutlineButton, primaryButton } from '../../components/styles'
import { formatDuration, isFree, slotToTime, startCandidates, type SlotRange } from '../../lib/slots'
import type { DraggedItem } from './drop'

const DAY_START = 54 // 09:00 when planning a day other than today

interface Props {
  placing: DraggedItem
  blocks: Block[]
  /** Current slot when the day is today; candidates start after it. */
  nowSlot: number | null
  onPlace: (range: SlotRange) => void
  onAskAI: () => void
  onClose: () => void
}

/** Phone flow for scheduling a brain dump item: pick a free start time, adjust the length. */
export function PlaceSheet({ placing, blocks, nowSlot, onPlace, onAskAI, onClose }: Props) {
  const [boxes, setBoxes] = useState(placing.boxes)
  const occupied = blocks.map((b) => ({ start: b.startSlot, end: b.endSlot }))
  const candidates = startCandidates(boxes, occupied, nowSlot === null ? DAY_START : nowSlot + 1)
  const [picked, setPicked] = useState<number | null>(candidates[0]?.start ?? null)
  const start = picked !== null && isFree({ start: picked, end: picked + boxes }, occupied) ? picked : (candidates[0]?.start ?? null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
      <div className="fixed inset-0 z-40 bg-[rgba(21,23,28,0.42)]" onPointerDown={onClose} />
      <section
        role="dialog"
        aria-label="시간표에 넣기"
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-4 rounded-t-[22px] border border-line bg-surface px-5 pt-2.5 pb-[max(env(safe-area-inset-bottom),24px)] shadow-[0_-8px_24px_rgba(21,23,28,0.14)]"
      >
        <span className="h-[5px] w-10 self-center rounded-full bg-line-strong" />
        <div>
          <h2 className="text-lg font-bold">시간표에 넣기</h2>
          <p className="text-sm text-muted">
            {placing.item.title} · 예상 {formatDuration(boxes)}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-semibold text-ink-2">{formatDuration(boxes)}이 비어 있는 시작 시각</span>
          {candidates.length === 0 ? (
            <p className="rounded-xl bg-ground px-3 py-4 text-center text-sm text-muted">오늘은 이만큼 빈 시간이 없어요. 길이를 줄여 보세요.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {candidates.map((c) => (
                <button
                  key={c.start}
                  aria-pressed={c.start === start}
                  onClick={() => setPicked(c.start)}
                  className={`flex h-14 flex-col items-center justify-center gap-px rounded-xl ${
                    c.start === start ? 'border-2 border-accent bg-accent/10 text-accent-ink' : 'border border-line-strong text-ink'
                  }`}
                >
                  <span className="font-mono text-[15px] font-medium">{slotToTime(c.start)}</span>
                  <span className="text-[11px] opacity-80">{formatDuration(c.freeBoxes)} 빔</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between rounded-xl bg-ground px-3 py-2.5">
          <span className="text-sm text-ink-2">길이</span>
          <span className="flex items-center gap-1">
            <button
              aria-label="10분 줄이기"
              disabled={boxes <= 1}
              onClick={() => setBoxes((b) => b - 1)}
              className="h-10 w-10 rounded-[10px] border border-line-strong bg-surface text-lg text-ink-2 disabled:opacity-30"
            >
              −
            </button>
            <span className="w-20 text-center font-mono text-[15px]">{formatDuration(boxes)}</span>
            <button
              aria-label="10분 늘리기"
              disabled={boxes >= 24}
              onClick={() => setBoxes((b) => b + 1)}
              className="h-10 w-10 rounded-[10px] border border-line-strong bg-surface text-lg text-ink-2 disabled:opacity-30"
            >
              +
            </button>
          </span>
        </div>

        <div className="flex gap-2">
          <button onClick={onAskAI} className={`${aiOutlineButton} h-12`}>
            <Sparkle size={16} />
            AI에게 맡기기
          </button>
          <button
            disabled={start === null}
            onClick={() => start !== null && onPlace({ start, end: start + boxes })}
            className={`${primaryButton} h-12 flex-1 text-[15px]`}
          >
            {start === null ? '넣을 시간 없음' : `${slotToTime(start)}에 넣기`}
          </button>
        </div>
      </section>
    </>
  )
}
