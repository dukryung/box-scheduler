// "말로 요청하기": typed and dictated requests, preview, apply, undo. Needs AI_PROVIDER=fake.
import { checker, fakeSpeech, json, launch, BASE, watchErrors } from './lib.mjs'

const D = '2026-11-05'
const { check, failed } = checker()
const errors = []
const browser = await launch()

const titles = async () =>
  Object.fromEntries((await json('GET', `/days/${D}`)).blocks.map((b) => [b.title, `${b.startSlot}-${b.endSlot}${b.source === 'ai' ? ' ai' : ''}`]))
const ORIGINAL = { 헬스장: '114-120', '책 읽기': '120-123', '코드 리뷰': '93-96' }
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort())
const input = (page) => page.getByRole('textbox', { name: '말로 요청하기' })
const fieldValue = (page) => page.evaluate(() => document.getElementById('assistant-input')?.value ?? '')

try {
  await json('POST', '/blocks', { date: D, startSlot: 114, endSlot: 120, title: '헬스장' })
  await json('POST', '/blocks', { date: D, startSlot: 120, endSlot: 123, title: '책 읽기' })
  await json('POST', '/blocks', { date: D, startSlot: 93, endSlot: 96, title: '코드 리뷰' })

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(page, errors)
  await page.goto(`${BASE}/day/${D}`)
  await page.locator('[data-block-id]').first().waitFor()
  const panel = page.getByRole('region', { name: '요청 결과' })

  // 1. ⌘K focuses the bar
  await page.keyboard.press('Meta+k')
  check(await page.evaluate(() => document.activeElement?.id === 'assistant-input'), '⌘K focuses the request bar')

  // 2. Typed request -> preview, nothing saved yet
  await input(page).fill('헬스장 21:00로 옮겨, 치과 13:00-14:00 추가, 코드 리뷰 삭제')
  await input(page).press('Enter')
  const apply = panel.getByRole('button', { name: /개 적용/ })
  await apply.waitFor()
  const rows = await panel.getByRole('list', { name: '바뀌는 내용' }).locator('li').allTextContents()
  check(rows.length === 3, `three changes listed: ${rows.join(' | ')}`)
  check(rows[0].includes('이동') && rows[0].includes('19:00–20:00 → 21:00–22:00'), 'move shows before → after')
  check(rows[1].includes('추가') && rows[1].includes('13:00–14:00'), 'add shows its time')
  check(rows[2].includes('삭제') && rows[2].includes('15:30–16:00'), 'remove shows the old time')
  check((await apply.textContent()) === '3개 적용 (삭제 포함)', 'apply button warns about deletion')
  check((await page.locator('[data-ghost-variant="add"]').count()) >= 2, 'new/moved positions previewed on the grid')
  check((await page.locator('[data-ghost-variant="remove"]').count()) === 1, 'deletion outlined in red on the grid')
  check(same(await titles(), ORIGINAL), 'nothing saved before confirming')

  // 3. Apply, then undo
  await apply.click()
  await page.getByText('3개를 바꿨어요').waitFor()
  check(same(await titles(), { 헬스장: '126-132', '책 읽기': '120-123', 치과: '78-84 ai' }), 'applied: moved, added, deleted')
  await page.locator('[data-block-id]', { hasText: '치과' }).first().waitFor()
  check((await page.locator('[data-ghost]').count()) === 0, 'previews cleared after applying')
  await page.getByRole('button', { name: '되돌리기' }).click()
  await page.getByText('되돌렸어요').waitFor()
  check(same(await titles(), ORIGINAL), 'undo restores the original day')

  // 4. Overlap is refused with a warning and nothing to apply
  await input(page).fill('헬스장 20:00로 옮겨')
  await input(page).press('Enter')
  await panel.getByText('확인 필요').waitFor()
  check(
    (await panel.textContent()).includes('겹쳐서 옮기지 않았어요') && (await panel.getByRole('button', { name: /개 적용/ }).count()) === 0,
    'overlap warned, no apply button',
  )

  // 5. Unclear request -> question back
  await input(page).fill('음')
  await input(page).press('Enter')
  await panel.getByText('위 입력창에 답해 주세요.').waitFor()
  check((await panel.textContent()).includes('무엇을 바꿀까요?'), 'asks a clarifying question')
  await page.getByRole('button', { name: '요청 닫기' }).click()
  check((await panel.count()) === 0, 'closing hides the panel')
  await page.close()

  // 6. Dictation: words stream into the field after typed text; ■ stops; Claude tidies; only ↑ sends
  const voice = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(voice, errors)
  await voice.addInitScript(fakeSpeech('음 책 읽기 좀 완료'))
  // Hold the tidy answer a moment so the waiting state can be seen.
  await voice.route('**/api/assistant/tidy', async (route) => {
    await new Promise((r) => setTimeout(r, 900))
    await route.continue()
  })
  await voice.goto(`${BASE}/day/${D}`)
  await voice.locator('[data-block-id]').first().waitFor()
  await input(voice).fill('코드 리뷰 완료,')
  await voice.getByRole('button', { name: '음성으로 말하기' }).click()
  await voice.waitForFunction(() => document.getElementById('assistant-input').value.includes('음 책'))
  const live = await fieldValue(voice)
  check(
    (await voice.getByRole('button', { name: '듣기 멈추기' }).isVisible()) && live.startsWith('코드 리뷰 완료, 음 책') && !live.endsWith('완료'),
    `words appear live, after the typed text: "${live}"`,
  )
  check(await voice.getByText('듣고 있어요 · 다 말했으면').isVisible(), 'listening hint shown')
  await voice.waitForFunction(() => document.getElementById('assistant-input').value.endsWith('완료'))
  check((await input(voice).getAttribute('autocomplete')) === 'off', 'browser autofill list turned off')
  await voice.getByRole('button', { name: '듣기 멈추기' }).click()
  await voice.getByText('말한 내용을 AI가 정리하는 중이에요').waitFor()
  check(
    (await input(voice).getAttribute('readonly')) !== null && (await voice.getByRole('button', { name: '보내기', exact: true }).isDisabled()),
    'while tidying: field locked and ↑ disabled',
  )
  await voice.getByText('AI가 정리했어요.').waitFor()
  check((await fieldValue(voice)) === '코드 리뷰 완료, 책 읽기 완료', `Claude's tidied request put in the field: "${await fieldValue(voice)}"`)
  await voice.waitForTimeout(100)
  check(await input(voice).evaluate((el) => el === document.activeElement), 'field focused for a quick edit')
  await voice.getByRole('button', { name: '말한 그대로 보기' }).click()
  check((await fieldValue(voice)) === '코드 리뷰 완료, 책 읽기 좀 완료', 'can switch back to what was said')
  await voice.getByRole('button', { name: '정리한 문장 보기' }).click()
  check((await fieldValue(voice)) === '코드 리뷰 완료, 책 읽기 완료', 'and back to the tidied text')
  const vPanel = voice.getByRole('region', { name: '요청 결과' })
  await voice.waitForTimeout(400)
  check((await vPanel.count()) === 0, 'not sent until the arrow is pressed')
  await voice.getByRole('button', { name: '보내기', exact: true }).click()
  await vPanel.getByRole('button', { name: /개 적용/ }).waitFor()
  check((await vPanel.getByRole('list', { name: '바뀌는 내용' }).locator('li').count()) === 2, 'typed and spoken parts both sent')
  await voice.close()

  // 7. Phone: mic button opens the sheet, which listens right away
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  watchErrors(phone, errors)
  await phone.addInitScript(fakeSpeech('어 코드 리뷰 좀 완료'))
  await phone.goto(`${BASE}/day/${D}`)
  await phone.locator('[data-block-id]').first().waitFor()
  check(
    (await input(phone).count()) === 0 && (await phone.getByRole('button', { name: '말로 요청하기' }).isVisible()),
    'phone has the mic button, no desktop bar',
  )
  await phone.getByRole('button', { name: '말로 요청하기' }).tap()
  const sheet = phone.getByRole('dialog', { name: '말로 요청하기' })
  await sheet.waitFor()
  await phone.waitForFunction(() => document.getElementById('assistant-input')?.value.includes('코드'))
  check(true, 'sheet streams words while listening')
  await phone.waitForFunction(() => document.getElementById('assistant-input').value.endsWith('완료'))
  await sheet.getByRole('button', { name: '듣기 멈추기' }).tap()
  await sheet.getByText('AI가 정리했어요.').waitFor()
  check((await fieldValue(phone)) === '코드 리뷰 완료', 'phone transcript tidied into the field')
  await phone.waitForTimeout(400)
  check((await sheet.getByRole('button', { name: /개 적용/ }).count()) === 0, 'phone: not sent until ↑ is tapped')
  await sheet.getByRole('button', { name: '보내기', exact: true }).tap()
  const pApply = sheet.getByRole('button', { name: /개 적용/ })
  await pApply.waitFor()
  check(await pApply.evaluate((el) => el.getBoundingClientRect().bottom <= window.innerHeight), 'apply button on screen')
  await pApply.tap()
  await phone.getByText('1개를 바꿨어요').waitFor()
  const review = (await json('GET', `/days/${D}`)).blocks.find((b) => b.title === '코드 리뷰')
  check(review?.done === true, 'phone request applied')
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no horizontal scroll')

  // 8. Dictation stops by itself after a few seconds of quiet
  const quiet = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  // The 502 below is staged, so only page errors count here.
  quiet.on('pageerror', (e) => errors.push(e.message))
  await quiet.addInitScript(fakeSpeech('헬스장 완료'))
  // Claude unavailable: the spoken text stays in the field.
  await quiet.route('**/api/assistant/tidy', (route) => route.fulfill({ status: 502, body: '{"error":"x"}' }))
  await quiet.goto(`${BASE}/day/${D}`)
  await quiet.locator('[data-block-id]').first().waitFor()
  await quiet.getByRole('button', { name: '음성으로 말하기' }).click()
  const t0 = Date.now()
  await quiet.getByText('정리하지 못해서 말한 그대로 두었어요').waitFor({ timeout: 10_000 })
  const waited = Date.now() - t0
  check(waited > 4500 && (await fieldValue(quiet)) === '헬스장 완료', `stopped after ~5s of silence (${waited}ms)`)
  check(await quiet.getByRole('button', { name: '보내기', exact: true }).isEnabled(), 'tidy failed: spoken text kept, ↑ ready')
  await quiet.close()

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  const { blocks } = await json('GET', `/days/${D}`)
  for (const b of blocks) await json('DELETE', `/blocks/${b.id}`)
  await browser.close()
}
process.exit(failed() ? 1 : 0)
