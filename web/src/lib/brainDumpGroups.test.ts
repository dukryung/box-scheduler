import { describe, expect, it } from 'vitest'
import type { Block, BrainDumpItem } from '../api/types'
import { groupBrainDump } from './brainDumpGroups'

const D = '2026-10-19'
const item = (id: string, over: Partial<BrainDumpItem> = {}): BrainDumpItem => ({
  id,
  date: D,
  title: id,
  estimateBoxes: null,
  priority: null,
  category: null,
  parentId: null,
  status: 'open',
  carriedFrom: null,
  dueDate: null,
  note: null,
  ...over,
})
const block = (id: string, itemId: string, start: number, done = false): Block => ({
  id,
  date: D,
  startSlot: start,
  endSlot: start + 3,
  title: itemId,
  color: null,
  brainDumpId: itemId,
  done,
  source: 'manual',
})

describe('groupBrainDump', () => {
  it('separates items without time from scheduled ones, in timetable order', () => {
    const g = groupBrainDump(
      [item('shopping'), item('lunch'), item('report'), item('mail', { status: 'done' }), item('old', { status: 'carried' })],
      [item('tax', { date: null })],
      [block('b1', 'lunch', 72), block('b2', 'report', 66), block('b3', 'report', 54), block('b4', 'mail', 48, true), block('b5', 'tax', 90)],
    )
    expect(g.unscheduled.map((r) => r.item.id)).toEqual(['shopping'])
    expect(g.scheduled.map((r) => r.item.id)).toEqual(['report', 'lunch', 'tax'])
    expect(g.scheduled[0].sessions.map((b) => b.id)).toEqual(['b3', 'b2'])
    expect(g.scheduled[2].linked).toBe('backlog')
    expect(g.done.map((r) => r.item.id)).toEqual(['mail'])
    expect(g.closed.map((r) => r.item.id)).toEqual(['old'])
  })
})
