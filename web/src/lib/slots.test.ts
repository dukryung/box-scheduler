import { describe, expect, it } from 'vitest'
import { formatRange, isFree, rowSegments, selectionRange, slotToTime } from './slots'

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
