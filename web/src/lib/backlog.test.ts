import { describe, expect, it } from 'vitest'
import type { BacklogItem } from '../api/types'
import { deadlineCounts, dueLabel, groupBacklog, urgentBacklog } from './backlog'

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
  blockCount: 0,
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

describe('urgentBacklog', () => {
  it('picks open items with time left that are important or due within a week', () => {
    const picked = urgentBacklog(
      [
        item('soon', { dueDate: '2026-10-26' }),
        item('late', { dueDate: '2026-11-30' }),
        item('overdue', { dueDate: '2026-10-01' }),
        item('important', { priority: 1 }),
        item('covered', { priority: 1, estimateBoxes: 6, scheduledBoxes: 6 }),
        item('finished', { priority: 1, status: 'done' }),
      ],
      T,
    )
    expect(picked.map((i) => i.id)).toEqual(['soon', 'overdue', 'important'])
  })
})
