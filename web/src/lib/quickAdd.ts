import { addDays, isValidISODate, parseISODate, todayISO } from './date'
import { SLOT_MINUTES } from './slots'

export interface QuickAdd {
  title: string
  estimateBoxes: number | null
  dueDate: string | null
  /** 1 = high (written as "!"). */
  priority: number | null
}

const DURATION_WORD = /^(\d+(?:\.\d+)?)(분|m|min|시간|h|hr)$/i
const UNIT_WORD = /^(분|m|min|시간|h|hr)$/i
const NUMBER_WORD = /^\d+(?:\.\d+)?$/
const RELATIVE_DAYS: Record<string, number> = { 오늘: 0, 내일: 1, 모레: 2 }

function toBoxes(value: number, unit: string): number | null {
  const minutes = /^(시간|h|hr)$/i.test(unit) ? value * 60 : value
  const boxes = Math.ceil(minutes / SLOT_MINUTES)
  return boxes >= 1 && boxes <= 144 ? boxes : null
}

/** "~10/30", "~2026-10-30", "~내일" → YYYY-MM-DD. A month/day already past means next year. */
export function parseDue(word: string, today: string): string | null {
  if (!word.startsWith('~')) return null
  const w = word.slice(1)
  if (w in RELATIVE_DAYS) return addDays(today, RELATIVE_DAYS[w])
  if (isValidISODate(w)) return w
  const md = w.match(/^(\d{1,2})\/(\d{1,2})$/)
  if (!md) return null
  const year = parseISODate(today).getFullYear()
  for (const y of [year, year + 1]) {
    const iso = `${y}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`
    if (isValidISODate(iso) && (iso >= today || y > year)) return iso
  }
  return null
}

/**
 * Reads trailing modifiers off a quick-add line, in any order:
 * "계약서 검토 1시간 ~10/30 !" → title, 6 boxes, due Oct 30, high priority.
 */
export function parseQuickAdd(input: string, today: string = todayISO()): QuickAdd {
  const text = input.trim()
  const words = text.split(/\s+/)
  const out: QuickAdd = { title: text, estimateBoxes: null, dueDate: null, priority: null }

  while (words.length > 1) {
    const last = words[words.length - 1]
    const due = parseDue(last, today)
    const dur = last.match(DURATION_WORD)
    if (last === '!' && out.priority === null) {
      out.priority = 1
      words.pop()
    } else if (due && out.dueDate === null) {
      out.dueDate = due
      words.pop()
    } else if (dur && out.estimateBoxes === null && toBoxes(Number(dur[1]), dur[2])) {
      out.estimateBoxes = toBoxes(Number(dur[1]), dur[2])
      words.pop()
    } else if (UNIT_WORD.test(last) && words.length > 2 && NUMBER_WORD.test(words[words.length - 2]) && out.estimateBoxes === null) {
      // "40 분" written with a space
      const boxes = toBoxes(Number(words[words.length - 2]), last)
      if (!boxes) break
      out.estimateBoxes = boxes
      words.splice(-2)
    } else {
      break
    }
  }

  out.title = words.join(' ')
  if (!out.title) return { title: text, estimateBoxes: null, dueDate: null, priority: null }
  return out
}
