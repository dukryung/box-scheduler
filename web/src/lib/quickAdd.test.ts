import { describe, expect, it } from 'vitest'
import { parseDue, parseQuickAdd } from './quickAdd'

const T = '2026-10-19'

describe('parseQuickAdd', () => {
  it('reads minutes and hours as boxes', () => {
    expect(parseQuickAdd('기획서 작성 40분', T)).toMatchObject({ title: '기획서 작성', estimateBoxes: 4 })
    expect(parseQuickAdd('운동 1시간', T)).toMatchObject({ title: '운동', estimateBoxes: 6 })
    expect(parseQuickAdd('리뷰 1.5h', T)).toMatchObject({ title: '리뷰', estimateBoxes: 9 })
    expect(parseQuickAdd('메일 15m', T)).toMatchObject({ title: '메일', estimateBoxes: 2 })
    expect(parseQuickAdd('메일 회신 20 분', T)).toMatchObject({ title: '메일 회신', estimateBoxes: 2 })
  })

  it('leaves text without trailing modifiers alone', () => {
    expect(parseQuickAdd('  장보기 ', T)).toEqual({ title: '장보기', estimateBoxes: null, dueDate: null, priority: null })
    expect(parseQuickAdd('3분기 계획', T)).toMatchObject({ title: '3분기 계획', estimateBoxes: null })
    expect(parseQuickAdd('30분', T)).toMatchObject({ title: '30분', estimateBoxes: null })
    expect(parseQuickAdd('!', T)).toMatchObject({ title: '!', priority: null })
  })

  it('reads a deadline and priority in any order', () => {
    expect(parseQuickAdd('계약서 검토 1시간 ~10/30 !', T)).toEqual({ title: '계약서 검토', estimateBoxes: 6, dueDate: '2026-10-30', priority: 1 })
    expect(parseQuickAdd('세금 신고 ! ~내일', T)).toEqual({ title: '세금 신고', estimateBoxes: null, dueDate: '2026-10-20', priority: 1 })
    expect(parseQuickAdd('여권 갱신 ~11/3 30분', T)).toMatchObject({ title: '여권 갱신', estimateBoxes: 3, dueDate: '2026-11-03' })
  })
})

describe('parseDue', () => {
  it('rolls a past month/day into next year', () => {
    expect(parseDue('~1/5', T)).toBe('2027-01-05')
    expect(parseDue('~10/19', T)).toBe('2026-10-19')
    expect(parseDue('~2026-12-01', T)).toBe('2026-12-01')
  })

  it('rejects anything that is not a deadline', () => {
    expect(parseDue('10/30', T)).toBeNull()
    expect(parseDue('~2/30', T)).toBeNull()
    expect(parseDue('~다음주', T)).toBeNull()
  })
})
