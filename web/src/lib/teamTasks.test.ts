import { describe, expect, it } from 'vitest'
import type { TeamTask } from '../api/types'
import { dailyLoad, loadStep, monthDays, periodText, taskSpan } from './teamTasks'

const task = (p: Partial<TeamTask>): TeamTask => ({
  id: 't',
  title: 't',
  note: '',
  status: 'todo',
  startDate: null,
  dueDate: null,
  estimateBoxes: null,
  createdBy: '',
  createdByName: '',
  createdAt: '',
  updatedAt: '',
  doneAt: null,
  assignees: [],
  canEdit: true,
  canSetStatus: true,
  ...p,
})
const who = (userId: string, boxes: number | null = null) => ({ userId, name: userId, email: `${userId}@x`, boxes })

describe('teamTasks', () => {
  it('lists the days of a month', () => {
    expect(monthDays('2026-02')).toHaveLength(28)
    expect(monthDays('2026-10').at(-1)).toBe('2026-10-31')
  })

  it('describes periods', () => {
    expect(periodText({ startDate: '2026-10-27', dueDate: '2026-11-07' })).toBe('10/27 ~ 11/7')
    expect(periodText({ startDate: null, dueDate: '2026-11-07' })).toBe('~ 11/7')
    expect(taskSpan({ startDate: null, dueDate: '2026-11-07' })).toEqual({ from: '2026-11-07', to: '2026-11-07' })
    expect(taskSpan({ startDate: null, dueDate: null })).toBeNull()
  })

  it('spreads each share over the weekdays of the period', () => {
    // Mon 10/26 .. Sun 11/1: five weekdays
    const load = dailyLoad([task({ startDate: '2026-10-26', dueDate: '2026-11-01', assignees: [who('a', 60), who('b', 30)] })], '2026-10-01')
    expect(load.get('a')?.get('2026-10-26')).toBe(12)
    expect(load.get('a')?.has('2026-10-31')).toBe(false)
    expect([...(load.get('b')?.values() ?? [])].reduce((s, v) => s + v, 0)).toBe(30)
  })

  it('splits the estimate when shares are not set, and adds tasks up', () => {
    const load = dailyLoad(
      [
        task({ startDate: '2026-10-26', dueDate: '2026-10-26', estimateBoxes: 48, assignees: [who('a'), who('b')] }),
        task({ startDate: '2026-10-26', dueDate: '2026-10-26', assignees: [who('a', 36)] }),
      ],
      '2026-10-01',
    )
    expect(load.get('a')?.get('2026-10-26')).toBe(60)
    expect(load.get('b')?.get('2026-10-26')).toBe(24)
  })

  it('runs from today without a start date; skips done and undated tasks', () => {
    const load = dailyLoad(
      [
        task({ dueDate: '2026-10-23', assignees: [who('a', 18)] }), // Wed..Fri from today
        task({ dueDate: '2026-10-23', status: 'done', assignees: [who('a', 99)] }),
        task({ assignees: [who('a', 99)] }),
      ],
      '2026-10-21',
    )
    expect([...(load.get('a')?.entries() ?? [])]).toEqual([
      ['2026-10-21', 6],
      ['2026-10-22', 6],
      ['2026-10-23', 6],
    ])
  })

  it('steps the heat by two hours and flags over eight', () => {
    expect([0, 1, 12, 13, 48, 49].map(loadStep)).toEqual([0, 1, 1, 2, 4, 5])
  })
})
