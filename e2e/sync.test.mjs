// Timetable ↔ Brain Dump: every block has an item; done, renames and deletes carry across.
import { checker, json, launch, BASE, watchErrors } from './lib.mjs'

const D = '2026-11-20'
const { check, failed } = checker()
const errors = []
const browser = await launch()
const day = () => json('GET', `/days/${D}`)

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(page, errors)
  await page.goto(`${BASE}/day/${D}`)
  await page.locator('[title="12:00"]').waitFor()
  const section = (name) => page.getByRole('region', { name })
  const row = (title) => page.locator('li', { hasText: title }).first()
  const cell = async (t) => {
    const c = page.locator(`[title="${t}"]`)
    await c.scrollIntoViewIfNeeded()
    const b = await c.boundingBox()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 8 })
    await page.mouse.up()
  }
  const openBlock = async (title) => {
    const b = await page.locator('[data-block-id]', { hasText: title }).first().boundingBox()
    await page.mouse.click(b.x + 20, b.y + b.height / 2)
    await page.getByRole('dialog', { name: '블록 편집' }).waitFor()
  }

  // 1. A block made on the timetable shows up in Brain Dump with its time
  await drag(await cell('12:00'), await cell('12:50'))
  await page.getByPlaceholder('무엇을 할까요?').fill('점심 먹기')
  await page.keyboard.press('Enter')
  await section('시간표에 있음').getByText('점심 먹기').waitFor()
  check((await row('점심 먹기').textContent()).includes('12:00–13:00'), 'grid block listed under 시간표에 있음 with its time')
  const lunch = (await day()).brainDump.find((it) => it.title === '점심 먹기')
  check(lunch && (await day()).blocks.find((b) => b.title === '점심 먹기')?.brainDumpId === lunch.id, 'block and item are linked')

  // 2. A Brain Dump entry stays off the timetable and is marked 미배정
  await page.getByLabel('Brain Dump 항목 추가').fill('장보기 30분')
  await page.getByLabel('Brain Dump 항목 추가').press('Enter')
  await section('아직 시간표에 없음').getByText('장보기').waitFor()
  check((await row('장보기').textContent()).includes('미배정'), 'brain dump item marked 미배정')
  check((await day()).blocks.length === 1, 'not added to the timetable')
  check((await page.getByRole('tab', { name: /Brain Dump/ }).textContent()).includes('1'), 'tab counts 1 미배정')
  const plan = section('아직 시간표에 없음').getByRole('button', { name: 'AI로 시간 정하기' })
  check((await plan.isVisible()) && (await page.getByRole('banner').getByRole('button', { name: /AI/ }).count()) === 0, 'AI planner button sits with the 미배정 items, not in the top bar')
  await plan.click()
  await page.getByRole('heading', { name: 'AI 일정 제안' }).waitFor()
  await page.getByRole('button', { name: '닫기' }).click()
  await section('아직 시간표에 없음').waitFor()

  // 3. Done carries both ways
  await openBlock('점심 먹기')
  await page.getByLabel('완료', { exact: true }).check()
  await page.keyboard.press('Escape')
  await section('완료').getByText('점심 먹기').waitFor()
  check(await row('점심 먹기').getByRole('checkbox').isChecked(), 'block done → item checked')
  await row('점심 먹기').getByRole('checkbox').uncheck()
  await page.waitForTimeout(500)
  check((await day()).blocks.find((b) => b.title === '점심 먹기').done === false, 'item unchecked → block unchecked')
  await row('점심 먹기').getByRole('checkbox').check()
  await page.waitForTimeout(500)
  check((await day()).blocks.find((b) => b.title === '점심 먹기').done === true, 'item checked → block checked')

  // 4. Renaming the block renames the item
  await openBlock('점심 먹기')
  await page.getByRole('dialog', { name: '블록 편집' }).getByRole('textbox').fill('팀 점심')
  await page.getByRole('button', { name: '저장' }).click()
  await section('완료').getByText('팀 점심').waitFor()
  check((await day()).brainDump.some((it) => it.title === '팀 점심'), 'block rename → item renamed')

  // 5. Time chip shows the block on the timetable
  await row('팀 점심').getByRole('button', { name: /시간표에서 12:00 블록 보기/ }).click()
  const flashed = await page.locator('[data-block-id].animate-pulse', { hasText: '팀 점심' }).first().waitFor({ timeout: 2000 }).then(() => true, () => false)
  check(flashed, 'time chip flashes its block')

  // 5b. "나중에" works for scheduled items too, without hovering; the block stays
  const later = row('팀 점심').getByRole('button', { name: '팀 점심 보관함으로 보내기' })
  check((await later.count()) === 0, 'done items have nothing to send to the backlog')
  await row('팀 점심').getByRole('checkbox').uncheck()
  await page.waitForTimeout(400)
  check(await later.isVisible(), '보관함으로 보내기 visible without hovering, on a scheduled item')
  await later.click()
  await section('시간표에 있음').locator('li', { hasText: '보관함' }).getByText('팀 점심').waitFor()
  check((await day()).blocks.some((b) => b.title === '팀 점심') && (await json('GET', '/tasks')).items.some((it) => it.title === '팀 점심'), 'moved to the backlog; its block stays and it shows as 보관함')
  await json('POST', `/brain-dump/${(await json('GET', '/tasks')).items.find((it) => it.title === '팀 점심').id}/move`, { date: D })
  await page.reload()
  await section('시간표에 있음').getByText('팀 점심').waitFor()

  // 6. Deleting the block deletes the item (the editor says so first)
  await openBlock('팀 점심')
  check(await page.getByText('삭제하면 Brain Dump에서도 지워져요.').isVisible(), 'delete hint shown')
  await page.getByRole('dialog', { name: '블록 편집' }).getByRole('button', { name: '삭제', exact: true }).click()
  await page.waitForTimeout(600)
  check(!(await day()).brainDump.some((it) => it.title === '팀 점심') && (await row('팀 점심').count()) === 0, 'block delete → item gone')

  // 7. Scheduling the 미배정 item moves it; deleting the item asks, then removes its block
  await page.locator('li', { hasText: '장보기' }).first().dragTo(page.locator('[title="15:00"]'))
  await section('시간표에 있음').getByText('장보기').waitFor()
  check(!(await row('장보기').textContent()).includes('미배정'), '미배정 mark gone once scheduled')
  await row('장보기').getByRole('button', { name: '장보기 삭제' }).click()
  check(await page.getByText('시간표의 블록 1개도 함께 지워져요.').isVisible(), 'item delete asks about its block')
  await page.getByRole('alertdialog', { name: '삭제 확인' }).getByRole('button', { name: '삭제' }).click()
  await page.waitForTimeout(600)
  check((await day()).blocks.length === 0 && (await page.locator('[data-block-id]').count()) === 0, 'item delete → block gone')

  // 8. A backlog item scheduled on this day is listed too
  const tax = await json('POST', '/tasks', { title: '세금 신고', estimateBoxes: 6 })
  await json('POST', '/blocks', { date: D, startSlot: 90, endSlot: 93, title: '세금 신고', brainDumpId: tax.id })
  await page.reload()
  await section('시간표에 있음').getByText('세금 신고').waitFor()
  check((await row('세금 신고').textContent()).includes('보관함'), 'backlog item shown with a 보관함 badge')
  await page.close()

  // 9. Phone: tap to create, then find it in the Brain Dump tab
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  watchErrors(phone, errors)
  await phone.goto(`${BASE}/day/${D}`)
  const c = phone.locator('[title="08:00"]')
  await c.scrollIntoViewIfNeeded()
  await c.tap()
  await phone.getByPlaceholder('무엇을 할까요?').fill('아침 산책')
  await phone.getByRole('dialog', { name: '블록 추가' }).getByRole('button', { name: '추가', exact: true }).tap()
  await phone.waitForTimeout(600)
  await phone.getByRole('tab', { name: /Brain Dump/ }).tap()
  await phone.getByRole('region', { name: '시간표에 있음' }).getByText('아침 산책').waitFor()
  check(true, 'phone: tapped block appears in Brain Dump')

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  const { blocks, brainDump, linkedItems } = await day()
  for (const b of blocks) await json('DELETE', `/blocks/${b.id}`)
  for (const it of [...brainDump, ...linkedItems]) await json('DELETE', `/brain-dump/${it.id}`)
  for (const it of (await json('GET', '/tasks')).items) await json('DELETE', `/brain-dump/${it.id}`)
  await browser.close()
}
process.exit(failed() ? 1 : 0)
