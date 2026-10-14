import { SLOT_MINUTES } from './slots'

/** Boxes as h:mm, e.g. 16 boxes → "2:40". */
export function hm(boxes: number): string {
  const m = boxes * SLOT_MINUTES
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
}
