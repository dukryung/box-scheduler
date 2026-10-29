// A break between AI-planned blocks: the panel's setting, saved per account, and
// a change request that spaces the whole suggestion again. Needs AI_PROVIDER=fake,
// whose revisions read "쉬는 시간 N분".
import { checker, json, launch, BASE, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const browser = await launch()

const iso = (offset) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('sv-SE')
}
const D = iso(14)

async function clearDay(date) {
  const day = await json('GET', `/days/${date}`)
  for (const b of day.blocks) await json('DELETE', `/blocks/${b.id}`)
  for (const it of day.brainDump) await json('DELETE', `/brain-dump/${it.id}`)
}

try {
  await clearDay(D)
  await json('PUT', '/ai/plan-break', { breakMinutes: 0 })
  await json('POST', '/blocks', { date: D, startSlot: 54, endSlot: 57, title: 'E2E QT' })
  for (const [title, estimateBoxes] of [['E2E 기획서', 6], ['E2E 메일', 2]]) await json('POST', '/brain-dump', { date: D, title, estimateBoxes })

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(page, errors)
  await page.goto(`${BASE}/day/${D}`)
  await page.getByRole('button', { name: 'AI로 시간 정하기' }).first().click()

  // 1. The setting is saved for the account.
  const choice = page.getByLabel('블록 사이 쉬는 시간')
  await choice.selectOption('10')
  await page.waitForTimeout(300)
  check((await json('GET', '/ai/plan-break')).breakMinutes === 10, 'break setting saved')

  // 2. The suggestion keeps ten minutes after the saved block and between its own blocks.
  await page.getByRole('button', { name: '제안 받기' }).click()
  await page.getByRole('button', { name: /개 블록 적용/ }).waitFor()
  const list = page.getByRole('list', { name: '제안된 블록' })
  const timeOf = async (title) => (await list.locator('li', { hasText: title }).textContent()).match(/\d\d:\d\d–\d\d:\d\d/)?.[0]
  check((await timeOf('E2E 기획서')) === '09:40–10:40', `break after the saved block (${await timeOf('E2E 기획서')})`)
  check((await timeOf('E2E 메일')) === '10:50–11:10', `break between suggested blocks (${await timeOf('E2E 메일')})`)
  check(await page.getByText('블록 사이에 10분씩 쉬는 시간을 뒀어요').isVisible(), 'the break is mentioned')

  // 3. A change request asks for another break: the whole plan is spaced again, in the same order.
  const input = page.getByLabel('제안 수정 요청')
  await input.fill('쉬는 시간 20분')
  await input.press('Enter')
  await page.getByRole('list', { name: '수정 요청 기록' }).getByText('쉬는 시간 20분').waitFor()
  check((await timeOf('E2E 기획서')) === '09:50–10:50', `respaced with 20 minutes (${await timeOf('E2E 기획서')})`)
  check((await timeOf('E2E 메일')) === '11:10–11:30', `second block respaced (${await timeOf('E2E 메일')})`)
  check(await page.getByText('블록 사이에 20분씩 쉬는 시간을 뒀어요').isVisible(), 'the new break is mentioned')

  // 4. A later request about something else keeps the asked-for break.
  await input.fill('쉬는 시간 0분')
  await input.press('Enter')
  await page.getByRole('list', { name: '수정 요청 기록' }).getByText('쉬는 시간 0분').waitFor()
  check((await timeOf('E2E 기획서')) === '09:30–10:30', `no break: packed after the saved block (${await timeOf('E2E 기획서')})`)
  check((await timeOf('E2E 메일')) === '10:30–10:50', `no break between blocks (${await timeOf('E2E 메일')})`)
  check((await page.getByText(/분씩 쉬는 시간을 뒀어요/).count()) === 0, 'no break mentioned')
  check((await json('GET', '/ai/plan-break')).breakMinutes === 10, 'a change request does not change the setting')

  // 5. The setting is there after a reload.
  await page.reload()
  await page.getByRole('button', { name: 'AI로 시간 정하기' }).first().click()
  await page.waitForTimeout(300)
  check((await page.getByLabel('블록 사이 쉬는 시간').inputValue()) === '10', 'setting shown after reload')

  // 6. API: only 0-60 minutes in steps of ten.
  check((await json('PUT', '/ai/plan-break', { breakMinutes: 15 })).error?.includes('쉬는 시간'), '15 minutes refused')
  check((await json('POST', `/days/${D}/ai-suggest`, { fromSlot: 54, toSlot: 108, includeBacklog: false, breakMinutes: 90 })).error?.includes('쉬는 시간'), 'overlong break refused')

  await clearDay(D)
  check(errors.length === 0, `no page errors ${errors.join(' | ')}`)
} catch (e) {
  check(false, `crashed: ${e.stack}`)
} finally {
  await json('PUT', '/ai/plan-break', { breakMinutes: 0 }).catch(() => {})
  await browser.close()
}
process.exit(failed() ? 1 : 0)
