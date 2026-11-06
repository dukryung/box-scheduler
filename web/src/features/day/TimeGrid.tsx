import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Block } from '../../api/types'
import { isTempId } from '../../store/dayStore'
import {
  HOURS,
  SLOTS_PER_DAY,
  SLOTS_PER_HOUR,
  clamp,
  fitRange,
  formatDuration,
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
import { useIsMobile } from '../../lib/useIsMobile'
import { DEFAULT_BLOCK_COLOR } from './colors'

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
  /** 'remove' outlines a block that the pending change would delete. */
  variant?: 'add' | 'remove'
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
  /** Scroll to this block and flash it; `n` changes on every request. */
  focus: { id: string; n: number } | null
  /** An empty stretch between blocks to offer filling, if any. */
  gap?: SlotRange | null
  onGapClick?: (range: SlotRange, at: GridAnchor) => void
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
  focus,
  gap = null,
  onGapClick,
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

  const [flashId, setFlashId] = useState<string | null>(null)
  useEffect(() => {
    if (!focus) return
    const block = blocks.find((b) => b.id === focus.id)
    if (!block) return
    const row = Math.floor(block.startSlot / SLOTS_PER_HOUR)
    scrollRef.current?.scrollTo({ top: Math.max(0, row - 1) * rowHeight, behavior: 'smooth' })
    setFlashId(focus.id)
    const t = setTimeout(() => setFlashId(null), 1600)
    return () => clearTimeout(t)
    // Only when a new focus request comes in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus])

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
    if (target.closest('[data-gap]')) return // the fill button handles its own click
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
                className={`pt-1 text-right font-mono text-[11px] md:text-xs ${nowSlot !== null && Math.floor(nowSlot / SLOTS_PER_HOUR) === h ? 'font-medium text-accent dark:text-accent-bright' : 'text-faint'}`}
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
                    slot === nowSlot ? 'bg-accent/10' : '',
                  ].join(' ')}
                />
              )
            })}

            {/* Late in the hour the label hangs left so it stays inside the grid. */}
            {nowSlot !== null && (
              <div
                style={{ gridRow: Math.floor(nowSlot / SLOTS_PER_HOUR) + 1, gridColumn: (nowSlot % SLOTS_PER_HOUR) + 1 }}
                className={`pointer-events-none z-30 -mt-2.5 self-start rounded-md ${nowSlot % SLOTS_PER_HOUR >= 4 ? 'mr-1 justify-self-end' : 'ml-1.5 justify-self-start'} bg-ink px-1.5 font-mono text-[10px] font-medium whitespace-nowrap text-surface`}
              >
                지금 {slotToTime(nowSlot)}
              </div>
            )}

            {gap &&
              onGapClick &&
              dropBoxes === null &&
              !drag &&
              ghosts.length === 0 &&
              rowSegments(gap).map((seg, i, segs) => (
                <div
                  key={`gap-${seg.row}`}
                  style={{ gridRow: seg.row + 1, gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 1}` }}
                  className="pointer-events-none z-10 m-[3px] flex items-center justify-center rounded-xl border-[1.5px] border-dashed border-line-strong"
                >
                  {i === widestSegment(segs) && (
                    <button
                      type="button"
                      data-gap
                      onClick={(e) => onGapClick(gap, { x: e.clientX, y: e.clientY })}
                      className="pointer-events-auto flex max-w-full items-center gap-1 truncate rounded-full bg-surface px-2.5 py-0.5 text-[11px] font-semibold text-muted shadow-[0_1px_2px_rgba(28,25,23,0.08)] hover:text-accent md:text-xs"
                    >
                      빈 {formatDuration(gap.end - gap.start)} · 채우기
                    </button>
                  )}
                </div>
              ))}

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
                  data-ghost-variant={g.variant ?? 'add'}
                  className={[
                    'pointer-events-none z-20 m-[3px] flex items-center gap-1.5 overflow-hidden rounded-lg border-[1.5px] border-dashed px-2.5 text-xs font-semibold md:text-[13px]',
                    g.variant === 'remove'
                      ? 'border-danger bg-danger/10 text-danger'
                      : `border-ai text-ai-ink ${g.highlighted ? 'ai-ghost-active bg-ai/20' : 'bg-ai/[0.07]'}`,
                  ].join(' ')}
                >
                  {i === labelIdx &&
                    (g.variant === 'remove' ? (
                      <span className="truncate rounded bg-surface/90 px-1.5">삭제 예정</span>
                    ) : (
                      <>
                        <Sparkle size={13} className="shrink-0" />
                        <span className="truncate">{g.title}</span>
                      </>
                    ))}
                </div>
              ))
            })}

            {blocks.map((block) => {
              const isDragged = block.id === draggedId
              const range = isDragged ? drag!.range : toRange(block)
              const segments = rowSegments(range)
              const labelIdx = widestSegment(segments)
              // Orange is the one going on now; teal is done; the rest stay quiet, their color a dot.
              const state = block.done ? 'done' : nowSlot !== null && block.startSlot <= nowSlot && nowSlot < block.endSlot ? 'now' : 'planned'
              // A block whose time is over but is not marked done asks whether it was.
              const late = state === 'planned' && nowSlot !== null && block.endSlot <= nowSlot
              return segments.map((seg, i) => {
                const first = i === 0
                const last = i === segments.length - 1
                const wide = seg.colEnd - seg.colStart >= 4
                // On the block going on now, the part of this row already past is shaded.
                const segStart = seg.row * SLOTS_PER_HOUR + seg.colStart
                const passed = state === 'now' && nowSlot !== null ? Math.min(1, Math.max(0, (nowSlot - segStart) / (seg.colEnd - seg.colStart))) : 0
                return (
                  <div
                    key={`${block.id}-${seg.row}`}
                    data-block-id={block.id}
                    data-state={state}
                    style={{
                      gridRow: seg.row + 1,
                      gridColumn: `${seg.colStart + 1} / ${seg.colEnd + 1}`,
                    }}
                    className={[
                      state === 'done'
                        ? 'bg-done-soft text-done-ink'
                        : state === 'now'
                          ? 'now-glow bg-accent text-white'
                          : 'border border-line bg-subtle text-ink-2',
                      'relative z-10 my-[3px] flex touch-none items-center gap-1.5 overflow-hidden px-2 text-xs font-semibold transition-colors duration-300 md:px-2.5 md:text-[13px]',
                      first ? 'ml-[3px] rounded-l-xl' : '',
                      last ? 'mr-[3px] rounded-r-xl' : '',
                      isTempId(block.id) ? 'animate-pulse' : 'cursor-grab active:cursor-grabbing',
                      isDragged ? 'z-20 shadow-lg ring-2 ring-accent' : '',
                      block.id === flashId ? 'z-20 animate-pulse ring-2 ring-accent ring-offset-1' : '',
                      isDragged && dropInvalid ? 'opacity-50 ring-danger' : '',
                    ].join(' ')}
                  >
                    {passed > 0 && <span aria-hidden="true" className="absolute inset-y-0 left-0 bg-black/15" style={{ width: `${passed * 100}%` }} />}
                    {i === labelIdx && (
                      <>
                        {state === 'done' ? (
                          <span className="done-pop flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-done text-done-on">
                            <Check size={11} strokeWidth={3.2} />
                          </span>
                        ) : state === 'now' ? (
                          <span className="live-dot relative h-2 w-2 shrink-0 rounded-full bg-white" />
                        ) : (
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: block.color ?? DEFAULT_BLOCK_COLOR }} />
                        )}
                        {block.source === 'ai' && <Sparkle size={13} className="shrink-0" aria-label="AI 제안" />}
                        <span className={`relative truncate ${state === 'planned' ? '' : 'font-bold'}`}>{block.title}</span>
                        <span className="relative hidden shrink-0 font-mono text-[11px] font-normal opacity-80 md:inline">
                          {isDragged ? formatRange(range) : `${slotToTime(range.start)}–${slotToTime(range.end)}`}
                        </span>
                        {late && wide && (
                          <span className="ml-auto hidden shrink-0 rounded-full border border-line-strong bg-surface px-2 py-px text-[11px] font-bold text-ink-2 md:inline">끝냈나요?</span>
                        )}
                        {state === 'done' && wide && (
                          <span className="ml-auto hidden shrink-0 rounded-full bg-done px-2 py-px text-[11px] font-bold text-done-on md:inline">완료</span>
                        )}
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
