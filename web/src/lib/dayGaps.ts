import { SLOTS_PER_DAY, isFree, startCandidates, type SlotRange } from './slots'

/** The shortest gap worth offering to fill: 30분. */
export const MIN_GAP_BOXES = 3

/**
 * The first gap of at least 30분 between the day's blocks, starting no earlier than `from`.
 * Only gaps inside the planned day count, so the evening after the last block is not offered.
 */
export function nextGap(occupied: SlotRange[], from: number): SlotRange | null {
  const sorted = [...occupied].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    const start = Math.max(from, Math.max(...sorted.slice(0, i).map((r) => r.end)))
    const end = sorted[i].start
    if (end - start >= MIN_GAP_BOXES) return { start, end }
  }
  return null
}

/** Where a block of `boxes` can go from `from` on: the first free start, or null when the day is full. */
export function firstFreeStart(boxes: number, occupied: SlotRange[], from: number): number | null {
  if (from + boxes > SLOTS_PER_DAY) return null
  return startCandidates(boxes, occupied, from, 1)[0]?.start ?? null
}

/** A block moved to another day keeps its time when that is free, else takes the next free time, else the day's first. */
export function sameOrNextStart(range: SlotRange, occupied: SlotRange[]): number | null {
  if (isFree(range, occupied)) return range.start
  const boxes = range.end - range.start
  return firstFreeStart(boxes, occupied, range.start) ?? firstFreeStart(boxes, occupied, 0)
}
