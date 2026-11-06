// The day as it goes: filling an empty stretch from what is waiting, settling blocks
// left behind (done, later today, tomorrow), and finished work shown in teal.
import { checker, json, launch, BASE, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const browser = await launch()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const hhmm = (s) => `${String(Math.floor(s / 6)).padStart(2, '0')}:${String((s % 6) * 10).padStart(2, '0')}`
const made = []
// The page updates before the server answers; wait for the server to agree.
const until = async (get, ok) => {
  let v
  for (let i = 0; i < 40; i++) {
    v = await get()
    if (ok(v)) return v
    await sleep(150)
  }
  return v
}
const findOn = (date, title) => async () => (await json('GET', `/days/${date}`)).blocks.find((b) => b.title === title)
const items = []
const block = async (date, startSlot, endSlot, title, extra = {}) => {
  const b = await json('POST', '/blocks', { date, startSlot, endSlot, title, ...extra })
  made.push(b.id)
  return b
}

try {
  // Stay clear of a 10-minute mark so "now" holds still while the page is checked.
  const t = new Date()
  if (10 - ((t.getMinutes() + t.getSeconds() / 60) % 10) < 1.5) await sleep(100_000)
  const now = new Date()
  const today = iso(now)
  const tomorrow = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  const n = Math.floor((now.getHours() * 60 + now.getMinutes()) / 10)

  if (n >= 6 && n <= 136) {
    // Three blocks already over, one on soon, and a 40-minute gap before the next.
    await block(today, n - 6, n - 5, '아침 메일')
    await block(today, n - 4, n - 3, '지난 회의')
    await block(today, n - 3, n - 2, '정리 못한 일')
    await block(today, n, n + 1, '지금 할 일')
    await block(today, n + 1, n + 2, '곧 할 일')
    await block(today, n + 6, n + 7, '저녁 약속')
    const item = await json('POST', '/brain-dump', { date: today, title: '자료 읽기', estimateBoxes: 2 })
    items.push(item.id)

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    watchErrors(page, errors)
    await page.goto(`${BASE}/day/${today}`)
    await page.locator('[data-block-id]').first().waitFor()

    // 1. The gap between blocks offers what is waiting
    const fill = page.getByRole('button', { name: '빈 40분 · 채우기' })
    await fill.waitFor()
    check(await fill.isVisible(), 'the empty 40 minutes after the next block is offered')
    await fill.click()
    const picker = page.getByRole('dialog', { name: '빈 시간 채우기' })
    await picker.waitFor()
    check((await picker.textContent()).includes(`${hhmm(n + 2)}–${hhmm(n + 6)}`), 'the picker names the gap')
    const choice = picker.getByRole('list', { name: '넣을 할 일' }).getByRole('button', { name: /자료 읽기/ })
    check((await choice.textContent()).includes('20분'), 'a waiting Brain Dump item is listed with its estimate')
    await choice.click()
    await page.getByText(`자료 읽기을(를) ${hhmm(n + 2)}에 넣었어요`).waitFor()
    const day1 = await json('GET', `/days/${today}`)
    const placed = day1.blocks.find((b) => b.title === '자료 읽기')
    check(placed?.startSlot === n + 2 && placed.endSlot === n + 4 && placed.brainDumpId === item.id, 'it went into the start of the gap, linked to the item')
    made.push(placed?.id)
    check((await page.getByRole('button', { name: /채우기$/ }).count()) === 0, 'no gap of 30 minutes is left to offer')

    // 2. Blocks left behind, earliest first: done
    const strip = page.getByRole('region', { name: '지난 블록 정리' })
    await strip.waitFor()
    check((await strip.textContent()).includes('아침 메일') && (await strip.textContent()).includes('외 2개'), 'the earliest block left behind is asked about, with the count of the rest')
    await strip.getByRole('button', { name: '끝냈어요' }).click()
    const cheer = page.getByRole('status').filter({ hasText: '‘아침 메일’ 완료' })
    await cheer.waitFor()
    check((await until(findOn(today, '아침 메일'), (b) => b?.done))?.done, 'marked done, with the completion toast')
    // The toast can take it back
    await cheer.getByRole('button', { name: '되돌리기' }).click()
    await strip.getByText('외 2개').waitFor()
    check(!(await until(findOn(today, '아침 메일'), (b) => !b?.done))?.done, '되돌리기 on the toast makes it not done again')
    await strip.getByRole('button', { name: '끝냈어요' }).click()
    await cheer.waitFor()

    // 3. Later today: the first free time after now that fits
    await strip.getByText('지난 회의').waitFor()
    const later = strip.getByRole('button', { name: /^이따 / })
    check((await later.textContent()) === `이따 ${hhmm(n + 4)}`, `offers the first free time: ${await later.textContent()}`)
    await later.click()
    await strip.getByText('정리 못한 일').waitFor()
    const moved = await until(findOn(today, '지난 회의'), (b) => b?.startSlot === n + 4)
    check(moved?.startSlot === n + 4 && moved.endSlot === n + 5, 'moved to later today, same length')

    // 4. Tomorrow: same time when free
    await strip.getByRole('button', { name: '내일로' }).click()
    await page.getByText(`‘정리 못한 일’을(를) 내일 ${hhmm(n - 3)}로 옮겼어요`).waitFor()
    const next = (await json('GET', `/days/${tomorrow}`)).blocks.find((b) => b.title === '정리 못한 일')
    check(next?.startSlot === n - 3 && next.endSlot === n - 2, 'moved to tomorrow at the same time')
    check(!(await json('GET', `/days/${today}`)).blocks.some((b) => b.title === '정리 못한 일'), 'and is gone from today')
    await strip.waitFor({ state: 'detached' })
    check(true, 'nothing left behind: the strip goes away')

    // 5. Finished blocks are teal and never struck through
    const doneSeg = page.locator('[data-block-id][data-state="done"]', { hasText: '아침 메일' }).first()
    const deco = await doneSeg.evaluate((el) => getComputedStyle(el.querySelector('span.truncate')).textDecorationLine)
    check(deco === 'none', 'a done block is not struck through')

    // 6. Keys: Space finishes what is on now, ←/→ and T move between days, N opens a new entry
    await page.locator('body').click({ position: { x: 5, y: 890 } })
    await page.keyboard.press('Space')
    await page.getByRole('status').filter({ hasText: '‘지금 할 일’ 완료' }).waitFor()
    check((await until(findOn(today, '지금 할 일'), (b) => b?.done))?.done, 'Space finishes the block on now')
    await page.keyboard.press('ArrowRight')
    await page.waitForURL(`**/day/${tomorrow}`)
    await page.keyboard.press('t')
    await page.waitForURL(`**/day/${today}`)
    check(true, '→ goes to the next day and T back to today')
    await page.keyboard.press('n')
    check(await page.getByLabel('Brain Dump 항목 추가').evaluate((el) => el === document.activeElement), 'N focuses the Brain Dump entry')
    await page.keyboard.press('ArrowRight')
    check(page.url().endsWith(`/day/${today}`), 'keys typed into a field are left alone')
    await page.close()
  } else {
    console.log('SKIP day-flow checks: too close to midnight')
  }

  // 7. Month view: done items in teal with a check, planned ones quiet with a color dot
  const D = '2026-12-09'
  await block(D, 54, 60, '월간 완료', { color: '#2563eb' })
  await block(D, 60, 66, '월간 예정', { color: '#2563eb' })
  await json('PATCH', `/blocks/${made.at(-2)}`, { done: true })
  const month = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(month, errors)
  await month.goto(`${BASE}/month/2026-12`)
  const doneItem = month.locator('li', { hasText: '월간 완료' }).first()
  await doneItem.waitFor()
  const look = await doneItem.evaluate((el) => ({
    cls: el.className,
    deco: getComputedStyle(el.querySelector('span.truncate')).textDecorationLine,
    sr: el.textContent.includes('완료'),
  }))
  check(look.cls.includes('bg-done-soft') && look.deco === 'none', 'month: a done item is teal, not struck through')
  const planned = await month.locator('li', { hasText: '월간 예정' }).first().evaluate((el) => ({ cls: el.className, dot: el.querySelector('span.rounded-full')?.style.background }))
  check(planned.cls.includes('bg-subtle') && planned.dot.includes('37, 99, 235'), 'month: a planned item is quiet, its color a dot')
  await month.close()

  // 8. Stats: the run of finished days, as the API counts it
  {
    const to = iso(new Date())
    const st = await json('GET', `/stats?from=${to}&to=${to}`)
    check(Number.isInteger(st.streak) && st.streak >= 0, `stats carry the finish streak (${st.streak})`)
    const sp = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    watchErrors(sp, errors)
    await sp.goto(`${BASE}/stats`)
    await sp.getByTestId('completion-rate').waitFor()
    const chip = sp.getByText(/일 연속 완주$/)
    check(st.streak > 0 ? (await chip.textContent()) === `${st.streak}일 연속 완주` : (await chip.count()) === 0, 'the stats page shows the streak only when there is one')
    await sp.close()
  }

  // 9. Phones: the account menu is in every header, and the day header stays one row
  const phone = await browser.newPage({ viewport: { width: 375, height: 812 } })
  watchErrors(phone, errors)
  await phone.goto(`${BASE}/day/2026-12-09`)
  const account = phone.getByRole('button', { name: /^계정 메뉴/ })
  await account.waitFor()
  check(await account.isVisible(), 'phone day view: account button in the header')
  const h = (await phone.getByRole('banner').boundingBox()).height
  check(h < 72, `phone day header stays one row (${h}px)`)
  await account.click()
  check(await phone.getByRole('menu', { name: '계정' }).isVisible(), 'phone: the account menu opens')
  await phone.goto(`${BASE}/month/2026-12`)
  check(await phone.getByRole('button', { name: /^계정 메뉴/ }).isVisible(), 'phone month view: account button in the header')
  await phone.close()

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)
} finally {
  for (const id of made.filter(Boolean)) await json('DELETE', `/blocks/${id}`).catch(() => {})
  for (const id of items) await json('DELETE', `/brain-dump/${id}`).catch(() => {})
  await browser.close()
}
process.exit(failed() ? 1 : 0)
