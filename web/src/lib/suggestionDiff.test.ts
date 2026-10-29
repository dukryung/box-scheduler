import { describe, expect, it } from 'vitest'
import type { SuggestedBlock } from '../api/types'
import { diffSuggestion } from './suggestionDiff'

const b = (taskId: string, title: string, startSlot: number, endSlot: number): SuggestedBlock => ({ taskId, title, startSlot, endSlot, reason: '' })

describe('diffSuggestion', () => {
  it('marks moved, resized, new and removed blocks', () => {
    const before = [b('a', '기획서', 60, 66), b('b', '메일', 70, 72), b('c', '운동', 108, 114)]
    const after = [b('a', '기획서', 60, 66), b('c', '운동', 120, 126), b('d', '독서', 80, 83), b('b', '메일', 70, 73)]
    const { changes, removed } = diffSuggestion(before, after)
    expect(changes).toEqual([undefined, 'moved', 'new', 'resized'])
    expect(removed).toEqual([])
  })

  it('lists what is gone, matching repeated titles one by one', () => {
    const before = [b('a', '집중', 60, 63), b('a', '집중', 66, 69), b('b', '메일', 70, 72)]
    const { changes, removed } = diffSuggestion(before, [b('a', '집중', 60, 63)])
    expect(changes).toEqual([undefined])
    expect(removed.map((r) => `${r.title}@${r.startSlot}`)).toEqual(['집중@66', '메일@70'])
  })
})
