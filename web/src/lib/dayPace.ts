import type { Block } from '../api/types'
import { SLOT_MINUTES } from './slots'

/** How the day is going: not started, on plan, behind it, or all done. */
export type Pace = 'still' | 'run' | 'walk' | 'home'

/**
 * The day's pace. On the day itself it is on plan ('run') while the blocks that
 * have ended are done, and behind ('walk') once one of them is left undone.
 */
export function dayPace(blocks: Block[], now: number | null): Pace {
  if (!blocks.length) return 'still'
  if (blocks.every((b) => b.done)) return 'home'
  if (now === null) return blocks.some((b) => b.done) ? 'walk' : 'still'
  const nowSlot = Math.floor(now / SLOT_MINUTES)
  const behind = blocks.some((b) => !b.done && b.endSlot <= nowSlot)
  if (behind) return 'walk'
  const started = blocks.some((b) => b.done || b.startSlot <= nowSlot)
  return started ? 'run' : 'still'
}
