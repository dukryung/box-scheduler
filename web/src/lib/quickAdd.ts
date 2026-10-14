import { SLOT_MINUTES } from './slots'

const DURATION = /\s+(\d+(?:\.\d+)?)\s*(분|m|min|시간|h|hr)$/i

/** Splits "기획서 작성 40분" into a title and an estimate in 10-minute boxes. */
export function parseQuickAdd(input: string): { title: string; estimateBoxes: number | null } {
  const text = input.trim()
  const m = text.match(DURATION)
  if (!m) return { title: text, estimateBoxes: null }

  const value = Number(m[1])
  const minutes = /^(시간|h|hr)$/i.test(m[2]) ? value * 60 : value
  const boxes = Math.ceil(minutes / SLOT_MINUTES)
  const title = text.slice(0, m.index).trim()
  if (!title || boxes < 1 || boxes > 144) return { title: text, estimateBoxes: null }
  return { title, estimateBoxes: boxes }
}
