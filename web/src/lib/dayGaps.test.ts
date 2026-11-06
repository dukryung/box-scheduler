import { describe, expect, it } from 'vitest'
import { firstFreeStart, nextGap, sameOrNextStart } from './dayGaps'

const r = (start: number, end: number) => ({ start, end })

describe('nextGap', () => {
  it('finds the first gap of 30분 or more between blocks', () => {
    expect(nextGap([r(54, 60), r(61, 63), r(70, 72)], 0)).toEqual(r(63, 70))
  })
  it('starts the gap no earlier than now', () => {
    expect(nextGap([r(54, 60), r(70, 72)], 65)).toEqual(r(65, 70))
    expect(nextGap([r(54, 60), r(70, 72)], 68)).toBeNull()
  })
  it('does not offer the time before the first block or after the last', () => {
    expect(nextGap([r(54, 60)], 0)).toBeNull()
    expect(nextGap([], 0)).toBeNull()
  })
  it('looks past a long block that covers a short one', () => {
    expect(nextGap([r(54, 72), r(60, 62), r(73, 80), r(90, 92)], 0)).toEqual(r(80, 90))
  })
})

describe('firstFreeStart', () => {
  it('takes the first start where the length fits', () => {
    expect(firstFreeStart(3, [r(60, 62), r(64, 70)], 60)).toBe(70)
    expect(firstFreeStart(2, [r(60, 62), r(64, 70)], 60)).toBe(62)
  })
  it('gives null when the day has no room left', () => {
    expect(firstFreeStart(6, [], 140)).toBeNull()
  })
})

describe('sameOrNextStart', () => {
  it('keeps the time when it is free', () => {
    expect(sameOrNextStart(r(60, 66), [r(50, 55)])).toBe(60)
  })
  it('moves later, then to the start of the day', () => {
    expect(sameOrNextStart(r(60, 66), [r(58, 62)])).toBe(62)
    expect(sameOrNextStart(r(140, 144), [r(138, 144)])).toBe(0)
  })
})
