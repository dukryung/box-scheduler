import type { BrainDumpItem } from '../../api/types'

/** Item being dragged onto the grid and how many boxes it should take. */
export interface DraggedItem {
  item: BrainDumpItem
  boxes: number
}

export const DEFAULT_DROP_BOXES = 3

/** A partly scheduled item drops with just the remainder of its estimate. */
export function dropBoxes(item: BrainDumpItem, scheduled: number) {
  if (!item.estimateBoxes) return DEFAULT_DROP_BOXES
  const remaining = item.estimateBoxes - scheduled
  return remaining > 0 ? remaining : item.estimateBoxes
}
