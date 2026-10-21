// Team month view: task periods as bars over the month, and each person's
// planned hours per day (spread over weekdays, 8 hours a day, overload flagged).
// March 2027 starts on a Monday: 3/5 Fri, 3/6–7 weekend, 3/8 Mon.
import { BASE, call, checker, launch, removeUser, watchErrors } from './lib.mjs'
import { startFakeSMTP } from './fake-smtp.mjs'

const { check, failed } = checker()
const errors = []
const smtp = await startFakeSMTP()
const browser = await launch()
const tag = Date.now().toString(36)
const cleanup = []
let dropTeam = null

const signup = async (who, name) => {
  const r = await call('POST', '/auth/signup', { email: `${who}-${tag}@e2e.test`, password: 'month-pass-1234', name })
  await call('POST', '/auth/onboarded', null, r.cookie)
  cleanup.push(r.body.id)
  return { id: r.body.id, cookie: r.cookie, email: `${who}-${tag}@e2e.test` }
}
const linkFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = smtp.inbox.find((x) => x.to.includes(email))
    if (m) return m.link
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`no invite mail for ${email}`)
}

try {
  const lead = await signup('mlead', '팀장')
  const minji = await signup('mminji', '민지')
  const team = (await call('POST', '/teams', { name: `월간팀 ${tag}` }, lead.cookie)).body
  dropTeam = () => call('DELETE', `/teams/${team.id}`, { confirm: team.name }, lead.cookie)
  await call('POST', `/teams/${team.id}/invites`, { emails: [minji.email], role: 'member' }, lead.cookie)
  await call('POST', `/invites/${(await linkFor(minji.email)).split('/invite/')[1]}/accept`, null, minji.cookie)
  const add = (t) => call('POST', `/teams/${team.id}/tasks`, t, lead.cookie).then((r) => r.body)
  const as = (userId, boxes) => ({ userId, boxes })
  const weekend = await add({ title: '주말 걸친 일', startDate: '2027-03-05', dueDate: '2027-03-08', assignees: [as(minji.id, 12)] })
  await add({ title: '하루에 몰린 일', startDate: '2027-03-10', dueDate: '2027-03-10', assignees: [as(minji.id, 60)] })
  await add({ title: '다음 달로 이어짐', startDate: '2027-03-29', dueDate: '2027-04-02', assignees: [as(lead.id, 30)] })
  await add({ title: '끝낸 일', startDate: '2027-03-10', dueDate: '2027-03-10', status: 'done', assignees: [as(minji.id, 48)] })
  await add({ title: '팀장 일', startDate: '2027-03-15', dueDate: '2027-03-15', assignees: [as(lead.id, 6)] })
  await add({ title: '기간 없는 일', estimateBoxes: 6 })

  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  watchErrors(p, errors)
  await p.context().addCookies([{ name: 'bs_session', value: lead.cookie, url: BASE }])
  await p.goto(`${BASE}/team/${team.id}?tab=month&m=2027-03`)
  const gantt = p.getByRole('region', { name: '업무 일정' })
  const loadArea = p.getByRole('region', { name: '사람별 업무량' })
  await loadArea.waitFor()
  check((await p.getByRole('heading', { name: '2027년 3월' }).count()) === 1 && (await p.getByRole('tab', { name: '월간 일정', selected: true }).count()) === 1, 'month tab opens on the month in the address')

  // 1. Bars sit on their dates
  const bar = (title) => gantt.getByRole('button', { name: new RegExp(`^${title} ·`) })
  const dayX = async (d) => (await gantt.locator(`[data-day="${d}"]`).boundingBox()).x
  const b1 = await bar('주말 걸친 일').boundingBox()
  check(Math.abs(b1.x - (await dayX('2027-03-05'))) < 3 && Math.abs(b1.x + b1.width - ((await dayX('2027-03-08')) + (await gantt.locator('[data-day="2027-03-08"]').boundingBox()).width)) < 3, 'bar runs from 3/5 to 3/8')
  check((await bar('끝낸 일').getAttribute('aria-label')).includes('완료'), 'done tasks are still drawn (marked done)')
  check(await bar('다음 달로 이어짐').evaluate((el) => el.className.includes('rounded-r-none')), 'a task running into next month is cut square at the edge')
  check((await bar('기간 없는 일').count()) === 0 && (await p.getByText('기간이 없는 업무 1개는 표시되지 않아요').isVisible()), 'undated tasks are counted, not drawn')

  // 2. Load per person and day
  const cell = (name, md) => loadArea.getByRole('img', { name: new RegExp(`^${name} ${md} `) })
  check((await cell('민지', '3/5').textContent()) === '1' && (await cell('민지', '3/8').textContent()) === '1', '2 hours over Fri+Mon: 1 hour each')
  check((await cell('민지', '3/6').count()) === 0 && (await cell('민지', '3/7').count()) === 0, 'nothing on the weekend')
  check((await cell('민지', '3/10').textContent()) === '10!' && (await cell('민지', '3/10').getAttribute('aria-label')).includes('과부하'), '10 hours in a day is flagged (done work not counted)')
  check(await loadArea.getByLabel('민지', { exact: true }).getByText('! 과부하 1일').isVisible(), 'the row says how many days are over')
  check((await cell('팀장', '3/29').textContent()) === '1', "a task running past the month: this month's part is shown")

  // 3. Filter by person
  await p.getByLabel('사람 필터').selectOption({ label: '민지' })
  check((await bar('팀장 일').count()) === 0 && (await bar('하루에 몰린 일').count()) === 1, 'person filter: only their tasks')
  check((await loadArea.getByLabel('팀장', { exact: true }).count()) === 0, 'person filter: only their load')
  await p.getByLabel('사람 필터').selectOption('all')

  // 4. Next month and back
  await p.getByRole('button', { name: '다음 달', exact: true }).click()
  await p.getByRole('heading', { name: '2027년 4월' }).waitFor()
  check((await bar('다음 달로 이어짐').count()) === 1 && (await bar('주말 걸친 일').count()) === 0 && p.url().includes('m=2027-04'), 'April shows the rest of the running task')
  await p.getByRole('button', { name: '이번 달' }).click()
  check(!p.url().includes('m='), '이번 달 goes back to today')
  await p.goto(`${BASE}/team/${team.id}?tab=month&m=2027-03`)
  await loadArea.waitFor()

  // 5. A bar opens the editor; a new date moves it
  await bar('주말 걸친 일').click()
  const dlg = p.getByRole('dialog', { name: '업무 편집' })
  await dlg.getByLabel('마감일').fill('2027-03-12')
  await dlg.getByRole('button', { name: '저장' }).click()
  await dlg.waitFor({ state: 'detached' })
  await p.waitForFunction(() => document.querySelector('[aria-label^="주말 걸친 일 ·"]')?.getAttribute('aria-label').includes('3/12'))
  check((await call('GET', `/teams/${team.id}/tasks`, null, lead.cookie)).body.tasks.find((t) => t.id === weekend.id).dueDate === '2027-03-12', 'edited from the bar; the bar moved')
  check((await cell('민지', '3/12').textContent()) === '0.3', 'load spread again over 6 weekdays')

  // 6. Phone: the month scrolls inside its card, starting at today
  const ph = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, signedOut: true })
  watchErrors(ph, errors)
  await ph.context().addCookies([{ name: 'bs_session', value: lead.cookie, url: BASE }])
  await ph.goto(`${BASE}/team/${team.id}?tab=month`)
  await ph.getByRole('region', { name: '사람별 업무량' }).waitFor()
  await ph.waitForTimeout(200)
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: page does not scroll sideways')
  const today = new Date().getDate()
  check(today < 8 || (await ph.evaluate(() => document.querySelector('[data-today]')?.closest('.overflow-x-auto').scrollLeft > 0)), 'phone: scrolled so today is in view')

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  await dropTeam?.().catch(() => {})
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
  smtp.server.close()
}
process.exit(failed() ? 1 : 0)
