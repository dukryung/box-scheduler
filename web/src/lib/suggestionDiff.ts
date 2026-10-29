import type { SuggestedBlock } from '../api/types'

export type BlockChange = 'new' | 'moved' | 'resized'

export interface SuggestionDiff {
  /** What happened to each new block, by index; undefined when it is as before. */
  changes: (BlockChange | undefined)[]
  /** Blocks of the earlier suggestion that are gone. */
  removed: SuggestedBlock[]
}

const same = (a: SuggestedBlock, b: SuggestedBlock) => a.taskId === b.taskId && a.title === b.title

/** Compares a revised suggestion with the one before it, matching blocks by task and title. */
export function diffSuggestion(before: SuggestedBlock[], after: SuggestedBlock[]): SuggestionDiff {
  const left = [...before]
  const changes = after.map((b): BlockChange | undefined => {
    const i = left.findIndex((p) => same(p, b))
    if (i < 0) return 'new'
    const [p] = left.splice(i, 1)
    if (p.endSlot - p.startSlot !== b.endSlot - b.startSlot) return 'resized'
    if (p.startSlot !== b.startSlot) return 'moved'
    return undefined
  })
  return { changes, removed: left }
}
