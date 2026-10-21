// "AI로 세분화": the AI splits a backlog item, the server spreads the pieces over
// working days (09:00–18:00 minus lunch, at most 2 hours a day), and the person
// confirms before each day's share goes into that day's Brain Dump.
import { BASE, call, checker, json, launch, removeUser, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const browser = await launch()
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const now = new Date()
const today = iso(now)
const due = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14))
const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
const created = []
const cleanup = []
const clearPieces = async () => {
  for (const t of (await json('GET', '/tasks')).items) if (created.includes(t.id)) await json('DELETE', `/brain-dump/${t.id}`)
}

try {
  const task = await json('POST', '/tasks', { title: 'API 문서화', estimateBoxes: 120, dueDate: due })
  created.push(task.id)

  // 1. API: suggestion + spread
  const p = await json('POST', `/tasks/${task.id}/breakdown`, { today, now: hm })
  check(p.subtasks?.length === 3 && p.subtasks.reduce((n, s) => n + s.boxes, 0) === 120, 'AI suggests pieces adding up to the estimate')
  check(p.policy.capacity === 48 && p.policy.perTaskMax === 12 && p.policy.lunchStart === '11:00', 'policy: 8h day (lunch 11–12 off), 2h of one task a day')
  check(p.plan.days.every((d) => d.total <= 12 && d.total <= d.free), 'no day gets more than 2 hours or more than its free time')
  check(p.plan.days.every((d) => !/^(토|일)/.test(d.date) && ![0, 6].includes(new Date(d.date).getDay())), 'weekends left out')
  check(p.plan.days.at(-1).reserve, 'the last working day is kept in reserve')
  let order = 0
  check(p.plan.days.every((d) => d.pieces.every((x) => (x.sub >= order ? ((order = x.sub), true) : false))), 'pieces keep their order')

  // 2. Busy days get less
  const first = p.plan.days.find((d) => d.free > 0 && d.date !== today)
  const blk = await json('POST', '/blocks', { date: first.date, startSlot: 54, endSlot: 102, title: '하루 종일 회의' })
  const p2 = await json('POST', `/tasks/${task.id}/breakdown/allocate`, { today, now: hm, subtasks: p.subtasks })
  const busy = p2.plan.days.find((d) => d.date === first.date)
  check(busy.free === 6 && busy.total <= 6, `a mostly booked day gets only its free hour (${busy.total} boxes)`)
  await json('DELETE', `/blocks/${blk.id}`)
  const blkItem = (await json('GET', `/days/${first.date}`)).brainDump.find((i) => i.title === '하루 종일 회의')
  if (blkItem) await json('DELETE', `/brain-dump/${blkItem.id}`)

  // 3. Browser: open from the backlog, edit, confirm
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(page, errors)
  await page.goto(`${BASE}/tasks`)
  const row = page.locator('li', { hasText: 'API 문서화' }).first()
  await row.getByRole('button', { name: 'AI로 세분화' }).click()
  const dlg = page.getByRole('dialog', { name: 'AI 세분화' })
  await dlg.getByRole('region', { name: '하위 업무' }).waitFor()
  check((await dlg.getByLabel('나눈 일 이름').count()) === 3, 'dialog lists the suggested pieces')
  const applyBtn = dlg.getByRole('button', { name: /확인하고 Brain Dump에 추가/ })
  const before = await applyBtn.textContent()
  await dlg.getByLabel('검토와 마무리 포함').uncheck()
  await page.waitForFunction((b) => !document.querySelector('[role=dialog] footer')?.textContent.includes(b), before, { timeout: 5000 }).catch(() => {})
  check((await dlg.getByRole('status').last().textContent()).includes('합계 16시간'), 'unchecking a piece re-spreads (16h left)')
  await dlg.getByLabel('나눈 일 이름').first().fill('API 목록 정리')
  await page.waitForTimeout(500)
  check((await dlg.getByRole('region', { name: '날짜별 배분' }).textContent()).includes('API 목록 정리'), 'renaming shows in the day plan')
  await applyBtn.click()
  await page.getByText(/일에 \d+개로 나눠 Brain Dump에 넣었어요/).waitFor()
  check(true, 'applied with a confirmation message')
  await row.getByText(/세분화 \d+개/).waitFor()
  check(true, 'backlog row shows its pieces')

  // 4. Pieces in day Brain Dumps
  const days = p.plan.days.filter((d) => d.total > 0).map((d) => d.date)
  let pieces = []
  for (const d of new Set(p2.plan.days.map((x) => x.date))) {
    const day = await json('GET', `/days/${d}`)
    pieces.push(...day.brainDump.filter((i) => i.parentId === task.id))
  }
  check(pieces.length > 0 && pieces.every((i) => i.title.startsWith('API 문서화 · ') && i.dueDate === due), 'pieces are titled "API 문서화 · …" and carry the due date')
  check(pieces.reduce((n, i) => n + i.estimateBoxes, 0) === 96, `pieces add up to the confirmed 16h (${pieces.reduce((n, i) => n + i.estimateBoxes, 0)} boxes)`)
  check(pieces.some((i) => i.title === 'API 문서화 · API 목록 정리'), 'the edited name was used')
  check(!pieces.some((i) => i.title.includes('검토와 마무리')), 'the unchecked piece was left out')
  const dayOne = pieces.map((i) => i.date).sort()[0]
  await page.goto(`${BASE}/day/${dayOne}`)
  await page.locator('li', { hasText: 'API 문서화 · ' }).first().getByText('세분화', { exact: true }).waitFor()
  check(true, 'day view marks pieces with 세분화')

  // 5. Progress rolls up to the backlog item
  const piece = pieces.find((i) => i.date === dayOne)
  const b = await json('POST', '/blocks', { date: dayOne, startSlot: 60, endSlot: 60 + piece.estimateBoxes, title: piece.title, brainDumpId: piece.id })
  await json('PATCH', `/blocks/${b.id}`, { done: true })
  const t1 = (await json('GET', '/tasks')).items.find((t) => t.id === task.id)
  check(t1.doneBoxes === piece.estimateBoxes && t1.piecesDone === 1, `done piece counts toward the task (${t1.doneBoxes} boxes, ${t1.piecesDone} done)`)

  // 6. Splitting again replaces the open, unplaced pieces only
  const again = await json('POST', `/tasks/${task.id}/breakdown`, { today, now: hm })
  check(again.existing === pieces.length - 1, `offers to replace the ${pieces.length - 1} open, unplaced pieces`)
  const r = await json('POST', `/tasks/${task.id}/breakdown/apply`, { today, now: hm, subtasks: [{ title: '남은 작업', boxes: 30 }], replace: true })
  check(r.removed === pieces.length - 1 && r.created >= 3, `replaced (${r.removed} removed, ${r.created} added)`)
  const t2 = (await json('GET', '/tasks')).items.find((t) => t.id === task.id)
  check(t2.doneBoxes === piece.estimateBoxes, 'the finished piece and its block are kept')

  // 7. No due date: asked first; past due: refused; others' items: not found
  const nodue = await json('POST', '/tasks', { title: '이사 준비' })
  created.push(nodue.id)
  await page.goto(`${BASE}/tasks`)
  await page.locator('li', { hasText: '이사 준비' }).first().getByRole('button', { name: 'AI로 세분화' }).click()
  const d2 = page.getByRole('dialog', { name: 'AI 세분화' })
  await d2.getByLabel('언제까지 끝낼까요? (마감일)').fill(due)
  await d2.getByRole('button', { name: 'AI에게 세분화 추천 받기' }).click()
  await d2.getByRole('region', { name: '하위 업무' }).waitFor()
  check(true, 'without a due date the dialog asks for one first')
  await d2.getByRole('button', { name: '닫기' }).click()
  const past = await call('POST', `/tasks/${nodue.id}/breakdown`, { today, now: hm, dueDate: '2020-01-01' }, null)
  check(past.status === 401, 'needs sign-in')
  const pastOwner = await json('POST', `/tasks/${nodue.id}/breakdown`, { today, now: hm, dueDate: '2020-01-01' })
  check(pastOwner.error?.includes('지났어요'), 'a past due date is refused')
  const other = await call('POST', '/auth/signup', { email: `bd-${Date.now()}@e2e.test`, password: 'bd-pass-1234' })
  cleanup.push(other.body.id)
  check((await call('POST', `/tasks/${task.id}/breakdown/allocate`, { today, now: hm, subtasks: [] }, other.cookie)).status === 404, "someone else's task cannot be split")

  // 8. Phone: dialog fills the screen
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  watchErrors(phone, errors)
  await phone.goto(`${BASE}/tasks`)
  await phone.locator('li', { hasText: 'API 문서화' }).first().getByRole('button', { name: '다시 세분화' }).tap()
  await phone.getByRole('dialog', { name: 'AI 세분화' }).getByRole('region', { name: '하위 업무' }).waitFor()
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no sideways scroll')

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  // remove every piece and block made from these tasks
  for (let i = 0; i < 20; i++) {
    const d = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i))
    const day = await json('GET', `/days/${d}`)
    for (const it of day.brainDump.filter((x) => created.includes(x.parentId))) {
      for (const b of day.blocks.filter((x) => x.brainDumpId === it.id)) await json('DELETE', `/blocks/${b.id}`)
      await json('DELETE', `/brain-dump/${it.id}`)
    }
  }
  await clearPieces()
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
}
process.exit(failed() ? 1 : 0)
