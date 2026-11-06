import { useEffect } from 'react'
import { Close, Plus } from '../../components/icons'
import { formatDuration, formatRange, type SlotRange } from '../../lib/slots'
import { useIsMobile } from '../../lib/useIsMobile'
import type { DraggedItem } from '../braindump/drop'
import type { GridAnchor } from './TimeGrid'

const WIDTH = 320
const EST_HEIGHT = 360
const MARGIN = 8

export interface GapChoice extends DraggedItem {
  /** Where the item waits: today's Brain Dump or the 보관함. */
  from: 'braindump' | 'backlog'
}

interface Props {
  range: SlotRange
  at: GridAnchor
  choices: GapChoice[]
  onPick: (choice: GapChoice) => void
  onNew: () => void
  onClose: () => void
}

/** Fill an empty stretch: pick a waiting item to put there, or start a new block. */
export function GapPicker({ range, at, choices, onPick, onNew, onClose }: Props) {
  const mobile = useIsMobile()
  const free = range.end - range.start

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const placement = mobile
    ? 'fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] rounded-t-[22px] px-5 pt-2.5 pb-[max(env(safe-area-inset-bottom),24px)] shadow-[0_-8px_24px_rgba(21,23,28,0.14)]'
    : 'fixed z-50 max-h-[420px] rounded-2xl p-4 shadow-xl'
  const position = mobile
    ? undefined
    : {
        left: Math.max(MARGIN, Math.min(at.x - WIDTH / 2, window.innerWidth - WIDTH - MARGIN)),
        top: Math.max(MARGIN, Math.min(at.y + MARGIN, window.innerHeight - EST_HEIGHT - MARGIN)),
        width: WIDTH,
      }

  return (
    <>
      <div className={`fixed inset-0 z-40 ${mobile ? 'bg-[rgba(21,23,28,0.42)]' : ''}`} onPointerDown={onClose} />
      <section role="dialog" aria-label="빈 시간 채우기" className={`${placement} flex flex-col gap-3 border border-line bg-surface`} style={position}>
        {mobile && <span className="h-[5px] w-10 shrink-0 self-center rounded-full bg-line-strong" />}
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-[15px] font-bold">빈 시간 채우기</h2>
            <p className="font-mono text-xs text-muted">{formatRange(range)} 비어 있어요</p>
          </div>
          <button type="button" onClick={onClose} aria-label="닫기" className="-mr-1 rounded-lg p-1 text-muted hover:bg-subtle">
            <Close size={16} />
          </button>
        </div>

        {choices.length === 0 ? (
          <p className="rounded-xl bg-ground px-3 py-3 text-center text-sm text-muted">기다리는 할 일이 없어요</p>
        ) : (
          <ul className="-mx-1 flex min-h-0 flex-col overflow-y-auto" aria-label="넣을 할 일">
            {choices.map((c) => {
              const boxes = Math.min(c.boxes, free)
              return (
                <li key={c.item.id}>
                  <button
                    type="button"
                    onClick={() => onPick(c)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-subtle"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{c.item.title}</span>
                    <span className="shrink-0 text-[11px] text-muted">{c.from === 'backlog' ? '보관함' : 'Brain Dump'}</span>
                    <span className="w-14 shrink-0 text-right font-mono text-xs text-ink-2">{formatDuration(boxes)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <button
          type="button"
          onClick={onNew}
          className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-line-strong text-sm font-semibold text-ink-2 hover:bg-subtle"
        >
          <Plus size={15} /> 새 일정 만들기
        </button>
      </section>
    </>
  )
}
