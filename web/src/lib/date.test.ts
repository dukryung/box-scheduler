import { describe, expect, it } from 'vitest'
import { addDays, addMonths, formatDayTitle, isValidISODate, isValidMonth, monthGrid } from './date'

describe('date helpers', () => {
  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('adds months across year boundaries', () => {
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
  })

  it('validates dates and months', () => {
    expect(isValidISODate('2026-10-14')).toBe(true)
    expect(isValidISODate('2026-02-30')).toBe(false)
    expect(isValidISODate('2026-1-5')).toBe(false)
    expect(isValidMonth('2026-10')).toBe(true)
    expect(isValidMonth('2026-13')).toBe(false)
  })

  it('formats a day with its weekday', () => {
    expect(formatDayTitle('2026-10-14')).toBe('2026년 10월 14일 (수)')
  })
})

describe('monthGrid', () => {
  it('pads to whole Sunday-first weeks', () => {
    // Oct 2026 starts on a Thursday and ends on a Saturday.
    const days = monthGrid('2026-10')
    expect(days).toHaveLength(35)
    expect(days[0]).toBe('2026-09-27')
    expect(days[days.length - 1]).toBe('2026-10-31')
  })

  it('needs no padding when the month fills exact weeks', () => {
    // Feb 2026 starts on a Sunday and has 28 days.
    const days = monthGrid('2026-02')
    expect(days).toHaveLength(28)
    expect(days[0]).toBe('2026-02-01')
  })

  it('can span six weeks', () => {
    // Aug 2026 starts on a Saturday.
    expect(monthGrid('2026-08')).toHaveLength(42)
  })
})
