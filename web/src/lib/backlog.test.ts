import { describe, expect, it } from 'vitest'
import type { BacklogItem } from '../api/types'
import { deadlineCounts, dueLabel, groupBacklog } from './backlog'

const T = '2026-10-19'
const item = (id: string, over: Partial<BacklogItem> = {}): BacklogItem => ({
  id,
  date: null,
  title: id,
  estimateBoxes: null,
  priority: null,
  category: null,
  status: 'open',
  carriedFrom: null,
  dueDate: null,
  note: null,
  scheduledBoxes: 0,
  doneBoxes: 0,
  ...over,
})

describe('groupBacklog', () => {
  it('groups by deadline and sorts by priority, then deadline', () => {
    const groups = groupBacklog(
      [
        item('passport', { dueDate: '2026-10-24' }),
        item('tax', { dueDate: '2026-10-17' }),
        item('dentist'),
        item('contract', { dueDate: '2026-10-25', priority: 1 }),
        item('visa', { dueDate: '2026-11-20' }),
        item('old', { status: 'done' }),
      ],
      T,
    )
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ['overdue', ['tax']],
      ['week', ['contract', 'passport']],
      ['later', ['visa']],
      ['none', ['dentist']],
      ['done', ['old']],
    ])
  })
})

describe('dueLabel', () => {
  it('reads like a countdown', () => {
    expect(dueLabel('2026-10-17', T)).toBe('2일 지남')
    expect(dueLabel(T, T)).toBe('오늘 마감')
    expect(dueLabel('2026-10-20', T)).toBe('내일 마감')
    expect(dueLabel('2026-10-24', T)).toBe('D-5')
    expect(dueLabel('2026-12-01', T)).toBe('12/1 마감')
  })
})

describe('deadlineCounts', () => {
  it('counts overdue and due-by-tomorrow open items', () => {
    const items = [
      item('a', { dueDate: '2026-10-18' }),
      item('b', { dueDate: T }),
      item('c', { dueDate: '2026-10-20' }),
      item('d', { dueDate: '2026-10-25' }),
      item('e', { dueDate: '2026-10-10', status: 'done' }),
    ]
    expect(deadlineCounts(items, T)).toEqual({ overdue: 1, soon: 2 })
  })
})
