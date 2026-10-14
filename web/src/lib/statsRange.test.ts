import { describe, expect, it } from 'vitest'
import { presetRange } from './statsRange'

describe('presetRange', () => {
  it('counts today in rolling ranges', () => {
    expect(presetRange('7d', '2026-10-14')).toEqual({ from: '2026-10-08', to: '2026-10-14' })
    expect(presetRange('30d', '2026-10-14')).toEqual({ from: '2026-09-15', to: '2026-10-14' })
  })

  it('covers calendar months', () => {
    expect(presetRange('month', '2026-10-14')).toEqual({ from: '2026-10-01', to: '2026-10-14' })
    expect(presetRange('last-month', '2026-03-05')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(presetRange('last-month', '2026-01-10')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
  })
})
