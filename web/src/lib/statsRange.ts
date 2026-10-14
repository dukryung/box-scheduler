import { addDays, addMonths, monthOf, parseISODate, toISODate } from './date'

export const RANGE_PRESETS = [
  { id: '7d', label: '최근 7일' },
  { id: '30d', label: '최근 30일' },
  { id: 'month', label: '이번 달' },
  { id: 'last-month', label: '지난 달' },
] as const

export type RangePreset = (typeof RANGE_PRESETS)[number]['id']

export function isRangePreset(v: string | null): v is RangePreset {
  return RANGE_PRESETS.some((p) => p.id === v)
}

/** Inclusive date range for a preset, relative to `today`. */
export function presetRange(preset: RangePreset, today: string): { from: string; to: string } {
  switch (preset) {
    case '7d':
      return { from: addDays(today, -6), to: today }
    case '30d':
      return { from: addDays(today, -29), to: today }
    case 'month':
      return { from: `${monthOf(today)}-01`, to: today }
    case 'last-month': {
      const month = addMonths(monthOf(today), -1)
      const first = parseISODate(`${month}-01`)
      return { from: `${month}-01`, to: toISODate(new Date(first.getFullYear(), first.getMonth() + 1, 0)) }
    }
  }
}
