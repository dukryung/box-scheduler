export const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

function pad(n: number) {
  return String(n).padStart(2, '0')
}

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function todayISO(): string {
  return toISODate(new Date())
}

/** Parses YYYY-MM-DD as a local date (new Date('YYYY-MM-DD') would be UTC). */
export function parseISODate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function addDays(iso: string, days: number): string {
  const d = parseISODate(iso)
  d.setDate(d.getDate() + days)
  return toISODate(d)
}

export function formatDayTitle(iso: string): string {
  const d = parseISODate(iso)
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`
}

export function isValidISODate(iso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && toISODate(parseISODate(iso)) === iso
}

/** YYYY-MM of a YYYY-MM-DD date. */
export function monthOf(iso: string): string {
  return iso.slice(0, 7)
}

export function isValidMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
}

export function addMonths(month: string, n: number): string {
  const d = parseISODate(`${month}-01`)
  d.setMonth(d.getMonth() + n)
  return monthOf(toISODate(d))
}

export function formatMonthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${y}년 ${m}월`
}

/** Dates shown on a month calendar: whole weeks (Sunday first) covering the month. */
export function monthGrid(month: string): string[] {
  const first = parseISODate(`${month}-01`)
  const start = new Date(first)
  start.setDate(1 - first.getDay())
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
  const end = new Date(last)
  end.setDate(last.getDate() + (6 - last.getDay()))

  const days: string[] = []
  for (const d = start; d <= end; d.setDate(d.getDate() + 1)) days.push(toISODate(d))
  return days
}
