import { describe, expect, it } from 'vitest'
import type { Block } from '../api/types'
import { dayPace } from './dayPace'

const block = (startSlot: number, endSlot: number, done = false): Block => ({
  id: `${startSlot}`,
  date: '2026-11-05',
  startSlot,
  endSlot,
  title: 't',
  color: null,
  brainDumpId: null,
  done,
  source: 'manual',
})
const at = (h: number, m = 0) => h * 60 + m

describe('dayPace', () => {
  it('waits at the start before the first block', () => {
    expect(dayPace([block(54, 60)], at(8))).toBe('still')
    expect(dayPace([], at(12))).toBe('still')
  })
  it('runs while every block that has ended is done', () => {
    expect(dayPace([block(54, 60, true), block(78, 84)], at(13, 20))).toBe('run')
    expect(dayPace([block(78, 84)], at(13, 20))).toBe('run')
  })
  it('walks once a block that has ended is left undone', () => {
    expect(dayPace([block(54, 60), block(78, 84)], at(13, 20))).toBe('walk')
  })
  it('is home when everything is done', () => {
    expect(dayPace([block(54, 60, true)], at(8))).toBe('home')
  })
  it('on another day: waits if nothing is done, walks if some is', () => {
    expect(dayPace([block(54, 60), block(60, 66)], null)).toBe('still')
    expect(dayPace([block(54, 60, true), block(60, 66)], null)).toBe('walk')
  })
})
