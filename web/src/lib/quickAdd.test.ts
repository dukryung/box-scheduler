import { describe, expect, it } from 'vitest'
import { parseQuickAdd } from './quickAdd'

describe('parseQuickAdd', () => {
  it('reads minutes and hours as boxes', () => {
    expect(parseQuickAdd('기획서 작성 40분')).toEqual({ title: '기획서 작성', estimateBoxes: 4 })
    expect(parseQuickAdd('운동 1시간')).toEqual({ title: '운동', estimateBoxes: 6 })
    expect(parseQuickAdd('리뷰 1.5h')).toEqual({ title: '리뷰', estimateBoxes: 9 })
    expect(parseQuickAdd('메일 15m')).toEqual({ title: '메일', estimateBoxes: 2 })
  })

  it('leaves text without a trailing duration alone', () => {
    expect(parseQuickAdd('  장보기 ')).toEqual({ title: '장보기', estimateBoxes: null })
    expect(parseQuickAdd('3분기 계획')).toEqual({ title: '3분기 계획', estimateBoxes: null })
    expect(parseQuickAdd('30분')).toEqual({ title: '30분', estimateBoxes: null })
  })
})
