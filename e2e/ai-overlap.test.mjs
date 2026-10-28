// AI 제안 and a day that changes meanwhile: applying never collides with blocks
// added or moved after the plan was made. Needs AI_PROVIDER=fake.
import { checker, json, launch, BASE, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const browser = await launch()

const iso = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('sv-SE')
}
const D = iso(11)
const time = (s) => `${String(Math.floor(s / 6)).padStart(2, '0')}:${String((s % 6) * 10).padStart(2, '0')}`
const overlaps = (bs) => bs.some((a, i) => bs.some((b, j) => i < j && a.startSlot < b.endSlot && b.startSlot < a.endSlot))

async function clearDay(date) {
  const day = await json('GET', `/days/${date}`)
  for (const b of day.blocks) await json('DELETE', `/blocks/${b.id}`)
  for (const it of day.brainDump) await json('DELETE', `/brain-dump/${it.id}`)
}

try {
  await clearDay(D)
  for (const [startSlot, endSlot, title] of [[54, 57, 'E2E QT'], [58, 64, 'E2E 투자 공부']]) await json('POST', '/blocks', { date: D, startSlot, endSlot, title })
  const item = await json('POST', '/brain-dump', { date: D, title: 'E2E 고도화', estimateBoxes: 6 })

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(page, errors)
  await page.goto(`${BASE}/day/${D}`)
  await page.getByRole('button', { name: 'AI로 시간 정하기' }).first().click()
  await page.getByRole('button', { name: '제안 받기' }).click()
  await page.getByRole('button', { name: /개 블록 적용/ }).waitFor()
  const proposed = await page.getByRole('list', { name: '제안된 블록' }).textContent()
  const at = proposed.match(/(\d\d:\d\d)–(\d\d:\d\d)/)
  check(at && !proposed.includes('E2E QT'), `suggestion avoids the existing blocks (${at?.[0]})`)

  // 1. While the suggestion is on screen, something lands right where it was proposed.
  const [sh, sm] = at[1].split(':').map(Number)
  const start = sh * 6 + sm / 10
  const intruder = await json('POST', '/blocks', { date: D, startSlot: start, endSlot: start + 2, title: 'E2E 끼어든 일' })
  check(intruder.id, 'a block now sits where the AI proposed')

  await page.getByRole('button', { name: /개 블록 적용/ }).click()
  await page.getByText('겹치지 않게 시간을 옮겼어요').waitFor()
  check(true, 'applying moves it instead of failing')
  const day = await json('GET', `/days/${D}`)
  const placed = day.blocks.find((b) => b.brainDumpId === item.id)
  check(placed && placed.endSlot - placed.startSlot === 6, `the block keeps its length (${placed && time(placed.startSlot)})`)
  check(placed && placed.startSlot >= start + 2, 'moved to the nearest free time after the intruder')
  check(!overlaps(day.blocks), 'nothing on the day overlaps')
  check(day.blocks.some((b) => b.id === intruder.id && b.startSlot === start), 'the block added meanwhile stays put')

  // 2. API: a block that fits nowhere is left out, not an error.
  const full = iso(12)
  await clearDay(full)
  await json('POST', '/blocks', { date: full, startSlot: 0, endSlot: 144, title: 'E2E 종일' })
  const other = await json('POST', '/brain-dump', { date: full, title: 'E2E 빈 시간 없음', estimateBoxes: 3 })
  const res = await json('POST', `/days/${full}/ai-apply`, { blocks: [{ taskId: other.id, title: 'E2E 빈 시간 없음', startSlot: 60, endSlot: 63 }], estimates: [] })
  check(res.skipped === 1 && res.moved === 0 && res.blocks.length === 0, 'no free time: skipped, nothing saved')

  // 3. API: free blocks are saved as asked.
  await clearDay(full)
  const kept = await json('POST', `/days/${full}/ai-apply`, { blocks: [{ taskId: '', title: 'E2E 그대로', startSlot: 60, endSlot: 63 }], estimates: [] })
  check(kept.moved === 0 && kept.blocks[0]?.startSlot === 60, 'free time: kept where it was proposed')

  await clearDay(D)
  await clearDay(full)
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
} catch (e) {
  check(false, `crashed: ${e.stack}`)
} finally {
  await browser.close()
}
process.exit(failed() ? 1 : 0)
