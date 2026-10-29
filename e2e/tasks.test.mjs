// 할 일 보관함 (backlog): page, day-view tab, deadlines, scheduling, AI. Needs AI_PROVIDER=fake.
import { checker, json, launch, BASE, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const browser = await launch()

const iso = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('sv-SE')
}
const md = (isoDate) => `${Number(isoDate.slice(5, 7))}/${Number(isoDate.slice(8, 10))}`
const T = iso(0)
const backlog = async () => (await json('GET', '/tasks')).items
const find = async (title) => (await backlog()).find((it) => it.title === title)

try {
  // Overdue items can't be typed (a past M/D means next year), so seed one directly.
  await json('POST', '/tasks', { title: 'E2E 세금 신고', dueDate: iso(-2) })

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(page, errors)
  await page.goto(`${BASE}/tasks`)
  const input = page.getByLabel('보관함에 할 일 추가')
  await input.waitFor()

  // 1. Quick add reads estimate, deadline, priority
  await input.fill(`E2E 계약서 검토 1시간 ~${md(iso(3))} !`)
  await input.press('Enter')
  await input.fill('E2E 치과 예약')
  await input.press('Enter')
  await page.getByText('E2E 치과 예약').waitFor()
  const contract = await find('E2E 계약서 검토')
  check(contract?.estimateBoxes === 6 && contract.dueDate === iso(3) && contract.priority === 1 && contract.date === null, 'quick add: 1시간, deadline, 중요, no date')

  // 2. Groups in order, with countdown labels
  const headings = await page.locator('main h2').allTextContents()
  check(headings.map((h) => h.split(' ')[0]).join(',') === '기한,이번,마감', `groups in order: ${headings.join(' | ')}`)
  const overdue = page.getByRole('region', { name: '기한 지남' })
  check((await overdue.textContent()).includes('2일 지남'), 'overdue item shows how late it is')
  const week = page.getByRole('region', { name: '이번 주' })
  check((await week.textContent()).includes('D-3') && (await week.textContent()).includes('중요'), 'this-week item shows D-3 and 중요')
  check((await overdue.locator('h2').textContent()).startsWith('기한 지남 1'), 'overdue group heading shows the count')

  // 3. Edit: deadline, priority, memo
  const dentistRow = page.locator('li', { hasText: 'E2E 치과 예약' })
  await dentistRow.getByRole('button', { name: '편집' }).click()
  await dentistRow.getByLabel('마감일').fill(iso(2))
  await dentistRow.getByRole('radio', { name: '낮음' }).click()
  await dentistRow.getByLabel('메모').fill('치과 전화번호 02-000-0000')
  await dentistRow.getByLabel('메모').blur()
  await page.waitForTimeout(500)
  const dentist = await find('E2E 치과 예약')
  check(dentist.dueDate === iso(2) && dentist.priority === 3 && dentist.note === '치과 전화번호 02-000-0000', 'deadline, priority and memo saved')
  check((await week.textContent()).includes('E2E 치과 예약'), 'item moved into 이번 주 after getting a deadline')

  // 4. 오늘 하기 moves an item onto today's Brain Dump
  await page.locator('li', { hasText: 'E2E 계약서 검토' }).getByRole('button', { name: '오늘 하기' }).click()
  await page.getByText('오늘 Brain Dump로 옮겼어요').waitFor()
  const today = await json('GET', `/days/${T}`)
  check(today.brainDump.some((it) => it.title === 'E2E 계약서 검토') && !(await find('E2E 계약서 검토')), 'moved out of the backlog onto today')
  await page.close()

  // 5. Day view: deadline banner opens the backlog tab
  const day = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(day, errors)
  await day.goto(`${BASE}/day/${T}`)
  const banner = day.getByRole('button', { name: /기한 지남 1개/ })
  await banner.waitFor()
  await banner.click()
  check((await day.getByRole('tab', { name: /보관함/ }).getAttribute('aria-selected')) === 'true', 'banner opens the 보관함 tab')
  const list = day.getByRole('list', { name: '보관함 할 일' })
  check((await list.locator('li').first().textContent()).includes('E2E 세금 신고'), 'overdue item listed first')

  // 6. Drag a backlog item onto the grid -> linked block, progress shown
  const cell = day.locator('[title="10:00"]')
  await cell.scrollIntoViewIfNeeded()
  await list.locator('li', { hasText: 'E2E 세금 신고' }).dragTo(cell)
  await day.locator('[data-block-id]', { hasText: 'E2E 세금 신고' }).first().waitFor()
  await day.waitForTimeout(500)
  const tax = await find('E2E 세금 신고')
  check(tax.scheduledBoxes === 3 && tax.date === null, 'scheduled 30분 and still in the backlog')
  check((await list.locator('li', { hasText: 'E2E 세금 신고' }).textContent()).includes('배정 30분'), 'backlog row shows 배정 30분')

  // 7. Completing its only block completes the item
  const block = day.locator('[data-block-id]', { hasText: 'E2E 세금 신고' }).first()
  const box = await block.boundingBox()
  await day.mouse.click(box.x + 20, box.y + box.height / 2)
  await day.getByLabel('완료', { exact: true }).check()
  await day.keyboard.press('Escape')
  await day.waitForTimeout(1200)
  check((await find('E2E 세금 신고'))?.status === 'done', 'item done once its scheduled time is done')
  check((await list.locator('li', { hasText: 'E2E 세금 신고' }).count()) === 0, 'finished item leaves the open list')

  // 8. Brain Dump "나중에" sends an item back to the backlog
  await day.getByRole('tab', { name: /Brain Dump/ }).click()
  await day.getByRole('button', { name: 'E2E 계약서 검토 보관함으로 보내기' }).click()
  await day.waitForTimeout(500)
  check((await find('E2E 계약서 검토'))?.date === null, '나중에 puts it back in the backlog')

  // 9. AI suggestion can include urgent backlog items
  await day.getByRole('region', { name: '아직 시간표에 없음' }).getByRole('button', { name: 'AI로 시간 정하기' }).click()
  const backlogOption = day.getByLabel('보관함에서 마감이 가깝거나 중요한 일도 함께 넣기')
  check(!(await backlogOption.isChecked()), 'backlog option off by default')
  // Only backlog items are left for this day, so nothing is planned without them.
  const off = await json('POST', `/days/${T}/ai-suggest`, { fromSlot: 54, toSlot: 132, includeBacklog: false })
  check(off.error === '배치할 Brain Dump 항목이 없어요', 'off: backlog items left out')
  await backlogOption.check()
  await day.getByRole('button', { name: '제안 받기' }).click()
  await day.getByRole('button', { name: /개 블록 적용/ }).waitFor()
  const proposed = await day.getByRole('list', { name: '제안된 블록' }).textContent()
  check(proposed.includes('E2E 계약서 검토') && proposed.includes('E2E 치과 예약'), 'urgent backlog items proposed')
  await day.getByRole('button', { name: '닫기' }).click()

  // 10. Month view marks deadlines
  await day.goto(`${BASE}/month/${iso(2).slice(0, 7)}`)
  const dueCell = day.locator(`a[href="/day/${iso(2)}"]`)
  await dueCell.getByText('마감 · E2E 치과 예약').waitFor()
  check(true, 'deadline chip on the month calendar')
  await day.close()

  // 11. Phone: backlog tab with 넣기, and the backlog page fits
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  watchErrors(phone, errors)
  await phone.goto(`${BASE}/day/${iso(1)}`)
  await phone.getByRole('tab', { name: /보관함/ }).tap()
  await phone.locator('li', { hasText: 'E2E 치과 예약' }).getByRole('button', { name: '넣기' }).tap()
  const sheet = phone.getByRole('dialog', { name: '시간표에 넣기' })
  await sheet.waitFor()
  await sheet.getByRole('button', { name: /에 넣기$/ }).tap()
  await phone.waitForTimeout(600)
  const tomorrow = await json('GET', `/days/${iso(1)}`)
  check(tomorrow.blocks.some((b) => b.title === 'E2E 치과 예약' && b.brainDumpId === dentist.id), 'phone 넣기 schedules a backlog item')
  check(await phone.getByRole('navigation', { name: '화면 전환' }).getByRole('link', { name: '보관함' }).isVisible(), '보관함 in the bottom tabs')
  await phone.goto(`${BASE}/tasks`)
  await phone.getByText('E2E 치과 예약').waitFor()
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'backlog page: no horizontal scroll at 390px')

  // 12. Deleting from the backlog: plain items go at once; scheduled ones ask first
  const plain = await json('POST', '/tasks', { title: 'E2E 그냥 지울 일' })
  const placed = await json('POST', '/tasks', { title: 'E2E 블록 있는 일' })
  await json('POST', '/blocks', { date: iso(3), startSlot: 60, endSlot: 63, title: 'E2E 블록 있는 일', brainDumpId: placed.id })
  const done1 = await json('POST', '/tasks', { title: 'E2E 끝낸 일 1' })
  const done2 = await json('POST', '/tasks', { title: 'E2E 끝낸 일 2' })
  for (const d of [done1, done2]) await json('PATCH', `/brain-dump/${d.id}`, { status: 'done' })
  const listPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(listPage, errors)
  await listPage.goto(`${BASE}/tasks`)
  await listPage.getByText('E2E 그냥 지울 일').waitFor()
  await listPage.getByRole('button', { name: 'E2E 그냥 지울 일 삭제' }).click()
  await listPage.waitForTimeout(400)
  check(!(await find('E2E 그냥 지울 일')), 'item without blocks deleted at once')
  await listPage.getByRole('button', { name: 'E2E 블록 있는 일 삭제' }).click()
  check(await listPage.getByText('시간표의 블록 1개도 함께 지워져요.').isVisible(), 'scheduled item asks before deleting')
  await listPage.getByRole('alertdialog', { name: '삭제 확인' }).getByRole('button', { name: '삭제' }).click()
  await listPage.waitForTimeout(400)
  check(!(await find('E2E 블록 있는 일')) && (await json('GET', `/days/${iso(3)}`)).blocks.length === 0, 'item and its block deleted')
  await listPage.getByText(/^완료 \d+/).click()
  await listPage.getByRole('button', { name: '완료한 일 모두 지우기' }).click()
  await listPage.getByRole('alertdialog', { name: '삭제 확인' }).getByRole('button', { name: '모두 지우기' }).click()
  await listPage.waitForTimeout(600)
  check((await backlog()).every((it) => it.status !== 'done'), '완료한 일 모두 지우기 clears finished items')
  await listPage.close()

  const tab = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(tab, errors)
  await json('POST', '/tasks', { title: 'E2E 탭에서 지울 일' })
  await tab.goto(`${BASE}/day/${iso(4)}`)
  await tab.getByRole('tab', { name: /보관함/ }).click()
  await tab.getByRole('button', { name: 'E2E 탭에서 지울 일 삭제' }).click()
  await tab.waitForTimeout(400)
  check(!(await find('E2E 탭에서 지울 일')), 'delete from the day view backlog tab')
  check(await tab.locator('li', { hasText: 'E2E 치과 예약' }).getByRole('button', { name: '이 날로' }).isVisible(), '이 날로 visible without hovering')
  await tab.close()

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  for (const d of [iso(0), iso(1), iso(3), iso(4)]) {
    const { blocks, brainDump } = await json('GET', `/days/${d}`)
    for (const b of blocks) await json('DELETE', `/blocks/${b.id}`)
    for (const it of brainDump) await json('DELETE', `/brain-dump/${it.id}`)
  }
  for (const it of await backlog()) await json('DELETE', `/brain-dump/${it.id}`)
  await browser.close()
}
process.exit(failed() ? 1 : 0)
