import { describe, expect, it } from 'vitest'
import { fitRange, formatRange, isFree, rowSegments, selectionRange, slotToTime, startCandidates } from './slots'

describe('slotToTime', () => {
  it('maps slot indexes to clock times', () => {
    expect(slotToTime(0)).toBe('00:00')
    expect(slotToTime(62)).toBe('10:20')
    expect(slotToTime(144)).toBe('24:00')
  })
})

describe('formatRange', () => {
  it('shows times and duration', () => {
    expect(formatRange({ start: 60, end: 62 })).toBe('10:00–10:20 · 20분')
    expect(formatRange({ start: 60, end: 69 })).toBe('10:00–11:30 · 1시간 30분')
    expect(formatRange({ start: 60, end: 72 })).toBe('10:00–12:00 · 2시간')
  })
})

describe('rowSegments', () => {
  it('keeps a range inside one hour as a single segment', () => {
    expect(rowSegments({ start: 60, end: 62 })).toEqual([{ row: 10, colStart: 0, colEnd: 2 }])
  })

  it('splits a range that crosses an hour boundary', () => {
    // 10:40–11:20
    expect(rowSegments({ start: 64, end: 68 })).toEqual([
      { row: 10, colStart: 4, colEnd: 6 },
      { row: 11, colStart: 0, colEnd: 2 },
    ])
  })
})

describe('selectionRange', () => {
  const occupied = [{ start: 62, end: 64 }]

  it('selects forward and backward from the anchor', () => {
    expect(selectionRange(50, 55, [])).toEqual({ start: 50, end: 56 })
    expect(selectionRange(55, 50, [])).toEqual({ start: 50, end: 56 })
  })

  it('stops before an existing block', () => {
    expect(selectionRange(58, 70, occupied)).toEqual({ start: 58, end: 62 })
    expect(selectionRange(66, 55, occupied)).toEqual({ start: 64, end: 67 })
  })
})

describe('isFree', () => {
  it('treats touching ranges as free and overlapping ones as taken', () => {
    const occupied = [{ start: 60, end: 62 }]
    expect(isFree({ start: 62, end: 63 }, occupied)).toBe(true)
    expect(isFree({ start: 61, end: 63 }, occupied)).toBe(false)
    expect(isFree({ start: 143, end: 145 }, occupied)).toBe(false)
  })
})

describe('fitRange', () => {
  const occupied = [{ start: 62, end: 64 }]

  it('uses the full length when there is room', () => {
    expect(fitRange(50, 3, occupied)).toEqual({ start: 50, end: 53 })
  })

  it('is cut short by the next block and the end of the day', () => {
    expect(fitRange(60, 4, occupied)).toEqual({ start: 60, end: 62 })
    expect(fitRange(142, 4, [])).toEqual({ start: 142, end: 144 })
  })

  it('rejects a drop onto an occupied slot', () => {
    expect(fitRange(63, 2, occupied)).toBeNull()
  })
})

describe('startCandidates', () => {
  // 09:00-10:30 and 13:00-14:00 are taken.
  const occupied = [
    { start: 54, end: 63 },
    { start: 78, end: 84 },
  ]

  it('offers gap starts and full hours where the task fits', () => {
    expect(startCandidates(5, occupied, 54, 5)).toEqual([
      { start: 63, freeBoxes: 15 }, // 10:30, gap start
      { start: 66, freeBoxes: 12 }, // 11:00
      { start: 72, freeBoxes: 6 }, // 12:00
      { start: 84, freeBoxes: 60 }, // 14:00, gap start
      { start: 90, freeBoxes: 54 }, // 15:00
    ])
  })

  it('skips gaps that are too short and stops at the end of the day', () => {
    expect(startCandidates(16, occupied, 54).map((c) => c.start)).toEqual([84, 90, 96, 102, 108, 114])
    expect(startCandidates(3, [], 140)).toEqual([{ start: 140, freeBoxes: 4 }])
  })
})
