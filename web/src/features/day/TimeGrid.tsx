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
import { DEFAULT_BLOCK_COLOR } from './colors'

const ROW_HEIGHT = 40

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

  // Start the view a little before "now" (or 08:00) instead of at midnight.
  useEffect(() => {
    const row = nowSlot !== null ? Math.floor(nowSlot / SLOTS_PER_HOUR) - 1 : 8
    scrollRef.current?.scrollTo({ top: Math.max(0, row) * ROW_HEIGHT })
    // Only on mount / day change, not every time "now" ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nowSlot === null])

  function slotFromPoint(clientX: number, clientY: number): number {
    const rect = cellsRef.current!.getBoundingClientRect()
    const col = clamp(Math.floor(((clientX - rect.left) / rect.width) * SLOTS_PER_HOUR), 0, SLOTS_PER_HOUR - 1)
    const row = clamp(Math.floor((clientY - rect.top) / ROW_HEIGHT), 0, HOURS - 1)
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex border-b border-zinc-200 pb-1 text-xs text-zinc-400 dark:border-zinc-800">
        <div className="w-12 shrink-0" />
        <div className="grid flex-1 grid-cols-6">
          {Array.from({ length: SLOTS_PER_HOUR }, (_, i) => (
            <div key={i} className="pl-1">
              :{String(i * 10).padStart(2, '0')}
            </div>
          ))}
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex">
          <div className="w-12 shrink-0">
            {Array.from({ length: HOURS }, (_, h) => (
              <div key={h} style={{ height: ROW_HEIGHT }} className="pr-2 pt-1 text-right text-xs text-zinc-400 tabular-nums">
                {String(h).padStart(2, '0')}
              </div>
            ))}
          </div>

          <div
            ref={cellsRef}
            className="grid flex-1 touch-pan-y select-none"
            style={{
              gridTemplateColumns: `repeat(${SLOTS_PER_HOUR}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${HOURS}, ${ROW_HEIGHT}px)`,
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
                    'border-b border-zinc-200 dark:border-zinc-800',
                    col === 2 ? 'border-r border-r-zinc-300 dark:border-r-zinc-700' : 'border-r border-r-zinc-100 dark:border-r-zinc-900',
                    selected ? 'bg-indigo-100 dark:bg-indigo-950' : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
                    slot === nowSlot ? 'ring-2 ring-inset ring-rose-400' : '',
                  ].join(' ')}
                />
              )
            })}

            {dropBoxes !== null &&
              dropRange &&
              rowSegments(dropRange).map((seg, i) => (
                <div
                  key={`drop-${seg.row}`}
                  style={{ gridRow: seg.row + 1, gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 1}` }}
                  className="pointer-events-none z-20 m-0.5 flex items-center rounded-md border-2 border-dashed border-indigo-500 bg-indigo-500/10 px-2 text-xs font-medium text-indigo-700 dark:text-indigo-300"
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
                    'pointer-events-none z-20 m-0.5 flex items-center overflow-hidden rounded-md border-2 border-dashed px-2 text-xs font-medium',
                    g.highlighted
                      ? 'border-violet-600 bg-violet-500/30 text-violet-900 dark:text-violet-100'
                      : 'border-violet-400 bg-violet-500/10 text-violet-700 dark:text-violet-300',
                  ].join(' ')}
                >
                  {i === labelIdx && <span className="truncate">✨ {g.title}</span>}
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
                      backgroundColor: block.color ?? DEFAULT_BLOCK_COLOR,
                    }}
                    className={[
                      'relative z-10 my-0.5 flex touch-none items-center overflow-hidden px-2 text-xs text-white shadow-sm',
                      first ? 'ml-0.5 rounded-l-md' : '',
                      last ? 'mr-0.5 rounded-r-md' : '',
                      isTempId(block.id) ? 'animate-pulse' : 'cursor-grab active:cursor-grabbing',
                      isDragged ? 'z-20 shadow-lg ring-2 ring-white/70' : '',
                      isDragged && dropInvalid ? 'opacity-50 ring-red-500' : '',
                      block.done ? 'opacity-50' : '',
                    ].join(' ')}
                  >
                    {i === labelIdx && (
                      <span className={`truncate font-medium ${block.done ? 'line-through' : ''}`}>
                        {block.source === 'ai' && '✨ '}
                        {block.title}
                        {isDragged && <span className="ml-1 font-normal opacity-80">{formatRange(range)}</span>}
                      </span>
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
