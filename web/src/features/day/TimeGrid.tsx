import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Block } from '../../api/types'
import { isTempId } from '../../store/dayStore'
import {
  HOURS,
  SLOTS_PER_DAY,
  SLOTS_PER_HOUR,
  clamp,
  fitRange,
  formatRange,
  isFree,
  nextBoundary,
  prevBoundary,
  rowSegments,
  selectionRange,
  slotToTime,
  type SlotRange,
} from '../../lib/slots'
import { Check, Sparkle } from '../../components/icons'
import { doneStrike } from '../../components/styles'
import { useIsMobile } from '../../lib/useIsMobile'
import { TONE_CLASS, toneVars } from './colors'

// Row height per hour: a little shorter on phones so more of the day fits.
const ROW_HEIGHT = 46
const ROW_HEIGHT_MOBILE = 44

type Drag =
  | { kind: 'select'; anchor: number; range: SlotRange }
  | { kind: 'move'; id: string; grabOffset: number; origin: SlotRange; range: SlotRange }
  | { kind: 'resize'; edge: 'start' | 'end'; id: string; origin: SlotRange; range: SlotRange }

/** A not-yet-saved block (an AI suggestion) drawn as a dashed preview. */
export interface GhostBlock {
  key: string
  range: SlotRange
  title: string
  highlighted: boolean
}

export interface GridAnchor {
  x: number
  y: number
}

interface Props {
  blocks: Block[]
  /** Slot to mark as "now", or null when not viewing today. */
  nowSlot: number | null
  /** Range waiting for a title in the create popover; kept highlighted. */
  pendingRange: SlotRange | null
  onSelect: (range: SlotRange, at: GridAnchor) => void
  onBlockClick: (id: string, at: GridAnchor) => void
  onBlockChange: (id: string, range: SlotRange) => void
  onInvalidDrop: () => void
  /** Length in boxes of a brain dump item currently being dragged, if any. */
  dropBoxes: number | null
  onItemDrop: (range: SlotRange) => void
  ghosts: GhostBlock[]
}

const toRange = (b: Block): SlotRange => ({ start: b.startSlot, end: b.endSlot })

export function TimeGrid({
  blocks,
  nowSlot,
  pendingRange,
  onSelect,
  onBlockClick,
  onBlockChange,
  onInvalidDrop,
  dropBoxes,
  onItemDrop,
  ghosts,
}: Props) {
  const cellsRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [dropRange, setDropRange] = useState<SlotRange | null>(null)
  const rowHeight = useIsMobile() ? ROW_HEIGHT_MOBILE : ROW_HEIGHT

  // Start the view a little before "now" (or 08:00) instead of at midnight.
  useEffect(() => {
    const row = nowSlot !== null ? Math.floor(nowSlot / SLOTS_PER_HOUR) - 1 : 8
    scrollRef.current?.scrollTo({ top: Math.max(0, row) * rowHeight })
    // Only on mount / day change, not every time "now" ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowSlot === null])

  // When AI suggestions appear, bring the earliest one into view (on phones it may
  // otherwise sit behind the suggestion sheet).
  const firstGhost = ghosts.length ? Math.min(...ghosts.map((g) => g.range.start)) : null
  useEffect(() => {
    if (firstGhost === null) return
    const row = Math.floor(firstGhost / SLOTS_PER_HOUR)
    scrollRef.current?.scrollTo({ top: Math.max(0, row - 1) * rowHeight, behavior: 'smooth' })
    // Only when a new set of suggestions arrives, not on every hover or toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstGhost === null])

  function slotFromPoint(clientX: number, clientY: number): number {
    const rect = cellsRef.current!.getBoundingClientRect()
    const col = clamp(Math.floor(((clientX - rect.left) / rect.width) * SLOTS_PER_HOUR), 0, SLOTS_PER_HOUR - 1)
    const row = clamp(Math.floor((clientY - rect.top) / rowHeight), 0, HOURS - 1)
    return row * SLOTS_PER_HOUR + col
  }

  const occupiedExcept = (id?: string) => blocks.filter((b) => b.id !== id).map(toRange)

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    const slot = slotFromPoint(e.clientX, e.clientY)
    const blockId = target.closest<HTMLElement>('[data-block-id]')?.dataset.blockId

    if (blockId) {
      const block = blocks.find((b) => b.id === blockId)
      if (!block || isTempId(block.id)) return
      const origin = toRange(block)
      const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge as 'start' | 'end' | undefined
      setDrag(
        edge
          ? { kind: 'resize', edge, id: block.id, origin, range: origin }
          : { kind: 'move', id: block.id, grabOffset: slot - block.startSlot, origin, range: origin },
      )
    } else {
      setDrag({ kind: 'select', anchor: slot, range: { start: slot, end: slot + 1 } })
    }
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return
    const slot = slotFromPoint(e.clientX, e.clientY)

    switch (drag.kind) {
      case 'select':
        setDrag({ ...drag, range: selectionRange(drag.anchor, slot, occupiedExcept()) })
        break
      case 'move': {
        const len = drag.origin.end - drag.origin.start
        const start = clamp(slot - drag.grabOffset, 0, SLOTS_PER_DAY - len)
        setDrag({ ...drag, range: { start, end: start + len } })
        break
      }
      case 'resize': {
        const others = occupiedExcept(drag.id)
        const { origin } = drag
        const range =
          drag.edge === 'end'
            ? { start: origin.start, end: clamp(slot + 1, origin.start + 1, nextBoundary(origin.end, others)) }
            : { start: clamp(slot, prevBoundary(origin.start, others), origin.end - 1), end: origin.end }
        setDrag({ ...drag, range })
        break
      }
    }
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    if (!drag) return
    setDrag(null)
    const at = { x: e.clientX, y: e.clientY }
    const unchanged = drag.kind !== 'select' && drag.range.start === drag.origin.start && drag.range.end === drag.origin.end

    if (drag.kind === 'select') {
      onSelect(drag.range, at)
    } else if (unchanged) {
      if (drag.kind === 'move') onBlockClick(drag.id, at)
    } else if (isFree(drag.range, occupiedExcept(drag.id))) {
      onBlockChange(drag.id, drag.range)
    } else {
      onInvalidDrop()
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    if (dropBoxes === null) return
    const range = fitRange(slotFromPoint(e.clientX, e.clientY), dropBoxes, occupiedExcept())
    setDropRange(range)
    if (range) {
      e.preventDefault() // allow the drop
      e.dataTransfer.dropEffect = 'copy'
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (dropRange) onItemDrop(dropRange)
    setDropRange(null)
  }

  const draggedId = drag && drag.kind !== 'select' ? drag.id : null
  const dropInvalid = drag?.kind === 'move' && !isFree(drag.range, occupiedExcept(drag.id))
  const highlight = drag?.kind === 'select' ? drag.range : pendingRange

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex gap-1.5 md:gap-3">
        <div className="w-6 shrink-0 md:w-[52px]" />
        <div className="grid flex-1 grid-cols-6 font-mono text-[10px] text-faint md:text-[11px]">
          {Array.from({ length: SLOTS_PER_HOUR }, (_, i) => (
            <span key={i}>:{String(i * 10).padStart(2, '0')}</span>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex gap-1.5 md:gap-3">
          <div className="w-6 shrink-0 md:w-[52px]">
            {Array.from({ length: HOURS }, (_, h) => (
              <div
                key={h}
                style={{ height: rowHeight }}
                className={`pt-1 text-right font-mono text-[11px] md:text-xs ${nowSlot !== null && Math.floor(nowSlot / SLOTS_PER_HOUR) === h ? 'font-medium text-accent' : 'text-faint'}`}
              >
                {String(h).padStart(2, '0')}
              </div>
            ))}
          </div>

          <div
            ref={cellsRef}
            className="grid flex-1 touch-pan-y select-none border-t border-l border-grid"
            style={{
              gridTemplateColumns: `repeat(${SLOTS_PER_HOUR}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${HOURS}, ${rowHeight}px)`,
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={() => setDrag(null)}
            onDragOver={handleDragOver}
            onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDropRange(null)}
            onDrop={handleDrop}
          >
            {Array.from({ length: SLOTS_PER_DAY }, (_, slot) => {
              const col = slot % SLOTS_PER_HOUR
              const selected = highlight !== null && slot >= highlight.start && slot < highlight.end
              return (
                <div
                  key={slot}
                  title={slotToTime(slot)}
                  style={{ gridRow: Math.floor(slot / SLOTS_PER_HOUR) + 1, gridColumn: col + 1 }}
                  className={[
                    'border-b border-grid',
                    col === 2 ? 'border-r border-r-line-strong/70' : 'border-r border-r-grid',
                    selected ? 'bg-accent-soft' : 'hover:bg-subtle/60',
                    slot === nowSlot ? 'rounded-md bg-accent/10 shadow-[inset_0_0_0_2px_var(--app-accent)]' : '',
                  ].join(' ')}
                />
              )
            })}

            {nowSlot !== null && (
              <div
                style={{ gridRow: Math.floor(nowSlot / SLOTS_PER_HOUR) + 1, gridColumn: (nowSlot % SLOTS_PER_HOUR) + 1 }}
                className="pointer-events-none z-30 -mt-2.5 ml-1.5 self-start justify-self-start rounded-md bg-accent px-1.5 font-mono text-[10px] font-medium whitespace-nowrap text-white"
              >
                지금 {slotToTime(nowSlot)}
              </div>
            )}

            {dropBoxes !== null &&
              dropRange &&
              rowSegments(dropRange).map((seg, i) => (
                <div
                  key={`drop-${seg.row}`}
                  style={{ gridRow: seg.row + 1, gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 1}` }}
                  className="pointer-events-none z-20 m-[3px] flex items-center rounded-lg border-2 border-dashed border-accent bg-accent/10 px-2 text-xs font-semibold text-accent-ink"
                >
                  {i === 0 && formatRange(dropRange)}
                </div>
              ))}

            {ghosts.map((g) => {
              const segments = rowSegments(g.range)
              const labelIdx = widestSegment(segments)
              return segments.map((seg, i) => (
                <div
                  key={`ghost-${g.key}-${seg.row}`}
                  data-ghost={g.key}
                  style={{ gridRow: seg.row + 1, gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 1}` }}
                  className={[
                    'pointer-events-none z-20 m-[3px] flex items-center gap-1.5 overflow-hidden rounded-lg border-[1.5px] border-dashed border-ai px-2.5 text-xs font-semibold text-ai-ink md:text-[13px]',
                    g.highlighted ? 'ai-ghost-active bg-ai/20' : 'bg-ai/[0.07]',
                  ].join(' ')}
                >
                  {i === labelIdx && (
                    <>
                      <Sparkle size={13} className="shrink-0" />
                      <span className="truncate">{g.title}</span>
                    </>
                  )}
                </div>
              ))
            })}

            {blocks.map((block) => {
              const isDragged = block.id === draggedId
              const range = isDragged ? drag!.range : toRange(block)
              const segments = rowSegments(range)
              const labelIdx = widestSegment(segments)
              return segments.map((seg, i) => {
                const first = i === 0
                const last = i === segments.length - 1
                return (
                  <div
                    key={`${block.id}-${seg.row}`}
                    data-block-id={block.id}
                    style={{
                      gridRow: seg.row + 1,
                      gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 1}`,
                      ...toneVars(block.color),
                    }}
                    className={[
                      TONE_CLASS,
                      'relative z-10 my-[3px] flex touch-none items-center gap-1.5 overflow-hidden px-2 text-xs font-semibold md:px-2.5 md:text-[13px]',
                      first ? 'ml-[3px] rounded-l-lg' : '',
                      last ? 'mr-[3px] rounded-r-lg' : '',
                      isTempId(block.id) ? 'animate-pulse' : 'cursor-grab active:cursor-grabbing',
                      isDragged ? 'z-20 shadow-lg ring-2 ring-accent' : '',
                      isDragged && dropInvalid ? 'opacity-50 ring-danger' : '',
                    ].join(' ')}
                  >
                    {i === labelIdx && (
                      <>
                        {block.done && <Check size={14} className="shrink-0" />}
                        {block.source === 'ai' && <Sparkle size={13} className="shrink-0" aria-label="AI 제안" />}
                        <span className={`truncate ${block.done ? doneStrike : ''}`}>{block.title}</span>
                        <span className="hidden shrink-0 font-mono text-[11px] font-normal opacity-75 md:inline">
                          {isDragged ? formatRange(range) : `${slotToTime(range.start)}–${slotToTime(range.end)}`}
                        </span>
                      </>
                    )}
                    {first && <div data-edge="start" className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" />}
                    {last && <div data-edge="end" className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" />}
                  </div>
                )
              })
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Index of the widest row piece, so a label stays readable when a block wraps rows. */
function widestSegment(segments: Array<{ colStart: number; colEnd: number }>): number {
  return segments.reduce(
    (best, s, i) => (s.colEnd - s.colStart > segments[best].colEnd - segments[best].colStart ? i : best),
    0,
  )
}
