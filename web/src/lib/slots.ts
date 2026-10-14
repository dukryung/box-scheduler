// One slot is a 10-minute box; a day has 24 rows of 6 slots.
export const SLOT_MINUTES = 10
export const SLOTS_PER_HOUR = 6
export const HOURS = 24
export const SLOTS_PER_DAY = SLOTS_PER_HOUR * HOURS

export interface SlotRange {
  start: number // inclusive
  end: number // exclusive
}

export function slotToTime(slot: number): string {
  const minutes = slot * SLOT_MINUTES
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function formatDuration(boxes: number): string {
  const mins = boxes * SLOT_MINUTES
  return mins >= 60 ? `${Math.floor(mins / 60)}시간${mins % 60 ? ` ${mins % 60}분` : ''}` : `${mins}분`
}

export function formatRange({ start, end }: SlotRange): string {
  return `${slotToTime(start)}–${slotToTime(end)} · ${formatDuration(end - start)}`
}

export function overlaps(a: SlotRange, b: SlotRange): boolean {
  return a.start < b.end && b.start < a.end
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

/**
 * Splits a range into per-hour row segments, since a block like 10:40–11:20
 * is drawn as two pieces on a 6-column grid.
 */
export function rowSegments({ start, end }: SlotRange): Array<{ row: number; colStart: number; colEnd: number }> {
  const segments = []
  for (let s = start; s < end; ) {
    const row = Math.floor(s / SLOTS_PER_HOUR)
    const rowEnd = Math.min(end, (row + 1) * SLOTS_PER_HOUR)
    segments.push({ row, colStart: s % SLOTS_PER_HOUR, colEnd: rowEnd - row * SLOTS_PER_HOUR })
    s = rowEnd
  }
  return segments
}

/** End of the closest range that finishes at or before `slot` (0 if none). */
export function prevBoundary(slot: number, ranges: SlotRange[]): number {
  let bound = 0
  for (const r of ranges) if (r.end <= slot && r.end > bound) bound = r.end
  return bound
}

/** Start of the closest range that begins at or after `slot` (SLOTS_PER_DAY if none). */
export function nextBoundary(slot: number, ranges: SlotRange[]): number {
  let bound = SLOTS_PER_DAY
  for (const r of ranges) if (r.start >= slot && r.start < bound) bound = r.start
  return bound
}

/**
 * The range a drag-select from `anchor` to `current` covers, stopping at the
 * first occupied slot so a selection never swallows an existing block.
 */
export function selectionRange(anchor: number, current: number, occupied: SlotRange[]): SlotRange {
  if (current >= anchor) {
    return { start: anchor, end: Math.min(current + 1, nextBoundary(anchor + 1, occupied)) }
  }
  return { start: Math.max(current, prevBoundary(anchor, occupied)), end: anchor + 1 }
}

export function isFree(range: SlotRange, occupied: SlotRange[]): boolean {
  return range.start >= 0 && range.end <= SLOTS_PER_DAY && !occupied.some((r) => overlaps(range, r))
}

/**
 * Where an item of `boxes` length lands when dropped on `slot`: it starts there
 * and is cut short by the next block. Null when `slot` itself is taken.
 */
export function fitRange(slot: number, boxes: number, occupied: SlotRange[]): SlotRange | null {
  if (!isFree({ start: slot, end: slot + 1 }, occupied)) return null
  return { start: slot, end: Math.min(slot + boxes, nextBoundary(slot, occupied)) }
}

/**
 * Start times worth offering for a `boxes`-long task: the start of every free gap
 * it fits in, plus each full hour inside longer gaps, from `from` on.
 */
export function startCandidates(
  boxes: number,
  occupied: SlotRange[],
  from: number,
  limit = 6,
): Array<{ start: number; freeBoxes: number }> {
  const out: Array<{ start: number; freeBoxes: number }> = []
  for (let s = Math.max(from, 0); s + boxes <= SLOTS_PER_DAY && out.length < limit; s++) {
    if (!isFree({ start: s, end: s + boxes }, occupied)) continue
    const gapStart = s === from || !isFree({ start: s - 1, end: s }, occupied)
    if (gapStart || s % SLOTS_PER_HOUR === 0) out.push({ start: s, freeBoxes: nextBoundary(s, occupied) - s })
  }
  return out
}
