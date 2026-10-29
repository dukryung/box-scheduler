// Asking the AI to change a suggestion before applying it. Needs AI_PROVIDER=fake,
// whose revisions read "<title> N시로", "<title> 빼줘" and "<title> N분" clauses.
import { checker, json, launch, BASE, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const browser = await launch()

const iso = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('sv-SE')
}
const D = iso(13)
const overlaps = (bs) => bs.some((a, i) => bs.some((b, j) => i < j && a.startSlot < b.endSlot && b.startSlot < a.endSlot))

async function clearDay(date) {
  const day = await json('GET', `/days/${date}`)
  for (const b of day.blocks) await json('DELETE', `/blocks/${b.id}`)
  for (const it of day.brainDump) await json('DELETE', `/brain-dump/${it.id}`)
}

try {
  await clearDay(D)
  await json('POST', '/blocks', { date: D, startSlot: 54, endSlot: 57, title: 'E2E 스탠드업' })
  for (const [title, estimateBoxes] of [['E2E 기획서', 6], ['E2E 메일', 2], ['E2E 운동', 6]]) await json('POST', '/brain-dump', { date: D, title, estimateBoxes })

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(page, errors)
  await page.goto(`${BASE}/day/${D}`)
  await page.getByRole('button', { name: 'AI로 시간 정하기' }).first().click()
  await page.getByRole('button', { name: '제안 받기' }).click()
  await page.getByRole('button', { name: /개 블록 적용/ }).waitFor()
  const list = page.getByRole('list', { name: '제안된 블록' })
  const row = (title) => list.locator('li', { hasText: title })
  const timeOf = async (title) => (await row(title).textContent()).match(/\d\d:\d\d–\d\d:\d\d/)?.[0]
  const plannedAt = await timeOf('E2E 기획서')
  check((await list.locator('li').count()) === 3, 'first suggestion has all three tasks')

  // 1. Switch one off, then ask for two changes at once.
  await row('E2E 기획서').getByRole('checkbox').uncheck()
  const input = page.getByLabel('제안 수정 요청')
  check(await input.isVisible(), 'revision box under the suggestion')
  await input.fill('E2E 운동 20시로, E2E 메일 빼줘')
  await input.press('Enter')
  await page.getByRole('list', { name: '수정 요청 기록' }).getByText('E2E 운동 20시로, E2E 메일 빼줘').waitFor()
  check((await input.inputValue()) === '', 'the box clears once the AI answers')
  check((await timeOf('E2E 운동')) === '20:00–21:00', `asked-for time honoured (${await timeOf('E2E 운동')})`)
  check((await row('E2E 운동').textContent()).includes('옮김'), 'moved block is marked')
  check((await page.getByRole('list', { name: '뺀 블록' }).textContent()).includes('E2E 메일'), 'left-out task listed as removed')
  check((await row('E2E 메일').count()) === 0, 'left-out task is gone from the list')
  check((await timeOf('E2E 기획서')) === plannedAt, 'untouched task stays where it was')
  check(!(await row('E2E 기획서').getByRole('checkbox').isChecked()), 'a block switched off stays off')
  check(await page.getByText('요청대로 고쳤어요').isVisible(), 'AI says what it changed')

  // 2. A second change builds on the first.
  await input.fill('E2E 운동 30분')
  await page.getByRole('button', { name: '고치기' }).click()
  await page.getByRole('list', { name: '수정 요청 기록' }).getByText('E2E 운동 30분').waitFor()
  check((await timeOf('E2E 운동')) === '20:00–20:30', `second change keeps the first (${await timeOf('E2E 운동')})`)
  check((await row('E2E 운동').textContent()).includes('길이 바뀜'), 'resized block is marked')
  check((await page.getByRole('list', { name: '수정 요청 기록' }).locator('li').count()) === 2, 'both requests listed')

  // 3. An asked-for time that is taken goes to the nearest free time, and says so.
  await input.fill('E2E 기획서 20시로')
  await input.press('Enter')
  await page.getByRole('list', { name: '수정 요청 기록' }).getByText('E2E 기획서 20시로').waitFor()
  check((await timeOf('E2E 기획서')) === '20:30–21:30', `taken time shifts to the next free one (${await timeOf('E2E 기획서')})`)
  check(await row('E2E 기획서').getByText('요청한 시간이 차 있어서').isVisible(), 'shift is explained')

  // 4. Applying saves the revised plan; the switched-off block stays out.
  await row('E2E 기획서').getByRole('checkbox').check()
  await page.getByRole('button', { name: '2개 블록 적용' }).click()
  await page.getByText('AI 제안 2개를 시간표에 추가했어요').waitFor()
  const day = await json('GET', `/days/${D}`)
  const at = (title) => day.blocks.find((b) => b.title === title)
  check(at('E2E 운동')?.startSlot === 120 && at('E2E 운동')?.endSlot === 123, 'revised block saved at 20:00–20:30')
  check(at('E2E 기획서')?.startSlot === 123, 'shifted block saved at 20:30')
  check(!at('E2E 메일') && !overlaps(day.blocks), 'left-out task not saved, nothing overlaps')

  // 5. API: empty or overlong requests are refused.
  const body = (request) => ({ fromSlot: 54, toSlot: 108, includeBacklog: false, revise: { previous: [], earlier: [], request } })
  check((await json('POST', `/days/${D}/ai-suggest`, body('  '))).error?.includes('수정 요청'), 'empty request refused')
  check((await json('POST', `/days/${D}/ai-suggest`, body('가'.repeat(301)))).error?.includes('수정 요청'), 'overlong request refused')

  // 6. Phone: the revision box fits the sheet.
  await clearDay(D)
  await json('POST', '/brain-dump', { date: D, title: 'E2E 폰 일', estimateBoxes: 3 })
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  watchErrors(phone, errors)
  await phone.goto(`${BASE}/day/${D}`)
  await phone.getByRole('tab', { name: /Brain Dump/ }).tap()
  await phone.getByRole('button', { name: 'AI로 시간 정하기' }).first().tap()
  await phone.getByRole('button', { name: '제안 받기' }).tap()
  await phone.getByRole('button', { name: /개 블록 적용/ }).waitFor()
  const box = await phone.getByLabel('제안 수정 요청').boundingBox()
  check(box && box.x >= 0 && box.x + box.width <= 390, 'revision box within the phone width')
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= 390), 'no sideways scroll on the phone')

  await clearDay(D)
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
} catch (e) {
  check(false, `crashed: ${e.stack}`)
} finally {
  await browser.close()
}
process.exit(failed() ? 1 : 0)
