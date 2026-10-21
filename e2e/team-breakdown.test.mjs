// AI로 세분화 for team tasks: an assignee's share is split into daily pieces in
// that person's Brain Dump (under a backlog item standing for the task), and
// their progress rolls up to the team task.
import { BASE, call, checker, json, launch, OWNER, removeUser, watchErrors } from './lib.mjs'
import { startFakeSMTP } from './fake-smtp.mjs'

const { check, failed } = checker()
const errors = []
const smtp = await startFakeSMTP()
const browser = await launch()
const tag = Date.now().toString(36)
const cleanup = []
let dropTeam = null
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const now = new Date()
const today = iso(now)
const due = iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14))
const hm = '09:00'

const signup = async (who, name) => {
  const r = await call('POST', '/auth/signup', { email: `${who}-${tag}@e2e.test`, password: 'split-pass-1234', name })
  await call('POST', '/auth/onboarded', null, r.cookie)
  cleanup.push(r.body.id)
  return { id: r.body.id, cookie: r.cookie, email: `${who}-${tag}@e2e.test`, name }
}
const linkFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = smtp.inbox.find((x) => x.to.includes(email))
    if (m) return m.link
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`no invite mail for ${email}`)
}
const pageAs = async (cookie) => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  watchErrors(p, errors)
  await p.context().addCookies([{ name: 'bs_session', value: cookie, url: BASE }])
  return p
}

try {
  // The test owner (server AI) leads; minji and jun are members.
  await json('GET', '/auth/me') // makes sure the owner account exists
  const lead = { cookie: (await call('POST', '/auth/login', { email: OWNER.email, password: OWNER.password })).cookie }
  lead.id = (await call('GET', '/auth/me', null, lead.cookie)).body.id
  await call('POST', '/auth/onboarded', null, lead.cookie)
  const minji = await signup('sminji', '민지')
  const jun = await signup('sjun', '준')
  const team = (await call('POST', '/teams', { name: `세분화팀 ${tag}` }, lead.cookie)).body
  dropTeam = () => call('DELETE', `/teams/${team.id}`, { confirm: team.name }, lead.cookie)
  for (const who of [minji, jun]) {
    await call('POST', `/teams/${team.id}/invites`, { emails: [who.email], role: 'member' }, lead.cookie)
    await call('POST', `/invites/${(await linkFor(who.email)).split('/invite/')[1]}/accept`, null, who.cookie)
  }
  const add = (t) => call('POST', `/teams/${team.id}/tasks`, t, lead.cookie).then((r) => r.body)
  const api = await add({ title: 'API 문서화', startDate: today, dueDate: due, estimateBoxes: 120, assignees: [{ userId: minji.id, boxes: 72 }, { userId: jun.id, boxes: 48 }] })
  const undated = await add({ title: '기간 없는 일', assignees: [{ userId: minji.id, boxes: 12 }] })
  const B = (who, task, path, body) => call('POST', `/teams/${team.id}/tasks/${task.id}/breakdown${path}`, { today, now: hm, ...body }, who.cookie)
  const taskNow = async (id) => (await call('GET', `/teams/${team.id}/tasks`, null, lead.cookie)).body.tasks.find((t) => t.id === id)

  // 1. The owner asks the AI for minji's share
  let r = await B(lead, api, '', { userId: minji.id })
  const subs = r.body.subtasks
  check(r.status === 200 && subs.reduce((n, s) => n + s.boxes, 0) === 72 && r.body.item.estimateBoxes === 72, `AI splits minji's 12 hours (${r.status})`)
  check(r.body.plan.days.every((d) => d.total <= 12 && d.date <= due && d.date >= today), 'within the task period, at most 2 hours a day')

  // 2. Who may split whose share
  check((await B(jun, api, '/allocate', { userId: minji.id, subtasks: subs })).status === 403, "a member cannot split someone else's share")
  check((await B(lead, api, '', { userId: lead.id })).status === 400, 'only assignees have a share to split')
  r = await B(lead, undated, '', { userId: minji.id })
  check(r.status === 400 && r.body.error.includes('마감일'), 'a task without a due date asks for one')

  // 3. Applying puts the pieces in minji's Brain Dump, under a backlog item for the task
  r = await B(lead, api, '/apply', { userId: minji.id, subtasks: subs, replace: true })
  check(r.status === 200 && r.body.created > 0 && r.body.task.assignees.find((a) => a.userId === minji.id).split, `applied: ${r.body.created} pieces`)
  const backlog = (await call('GET', '/tasks', null, minji.cookie)).body.items
  const linked = backlog.find((i) => i.title === 'API 문서화')
  check(linked && linked.estimateBoxes === 72 && linked.dueDate === due && linked.pieces === r.body.created, "minji's backlog has the task with her share and its pieces")
  const firstDay = r.body.plan.days.find((d) => d.pieces.length)
  const dayItems = (await call('GET', `/days/${firstDay.date}`, null, minji.cookie)).body.brainDump.filter((i) => i.parentId === linked.id)
  check(dayItems.length === firstDay.pieces.length, `her ${firstDay.date} Brain Dump has that day's pieces`)
  check(!(await call('GET', '/tasks', null, lead.cookie)).body.items.some((i) => i.title === 'API 문서화'), "nothing lands in the splitter's own backlog")
  let mine = (await taskNow(api.id)).assignees.find((a) => a.userId === minji.id)
  check(mine.plannedBoxes === 72 - r.body.shortage && mine.doneBoxes === 0, 'team task shows her planned hours')

  // 4. Progress rolls up as she finishes pieces
  await call('PATCH', `/brain-dump/${dayItems[0].id}`, { status: 'done' }, minji.cookie)
  mine = (await taskNow(api.id)).assignees.find((a) => a.userId === minji.id)
  check(mine.doneBoxes === dayItems[0].estimateBoxes, `finishing a piece counts (${mine.doneBoxes} boxes done)`)

  // 5. Splitting again swaps the open pieces and keeps the finished one
  const before = mine.plannedBoxes
  r = await B(lead, api, '/apply', { userId: minji.id, subtasks: [{ title: '남은 정리', boxes: 24 }], replace: true })
  mine = r.body.task.assignees.find((a) => a.userId === minji.id)
  check(r.body.removed > 0 && mine.doneBoxes === dayItems[0].estimateBoxes && mine.plannedBoxes === dayItems[0].estimateBoxes + 24 && before !== mine.plannedBoxes, 'resplit: open pieces replaced, done work kept')
  check((await call('GET', '/tasks', null, minji.cookie)).body.items.filter((i) => i.title === 'API 문서화').length === 1, 'still one backlog item for the task')

  // 6. A member splits their own share (no AI needed for a hand-made split)
  r = await B(jun, api, '/apply', { subtasks: [{ title: '예시 작성', boxes: 48 }], replace: true })
  check(r.status === 200 && r.body.task.assignees.find((a) => a.userId === jun.id).split, 'jun splits his own share')

  // 7. Browser: progress in the list; the editor offers the split per assignee
  const solo = await add({ title: '릴리스 노트', startDate: today, dueDate: due, estimateBoxes: 12, assignees: [{ userId: minji.id, boxes: 12 }] })
  const p = await pageAs(lead.cookie)
  await p.goto(`${BASE}/team/${team.id}`)
  await p.getByRole('button', { name: '목록' }).click()
  const row = p.getByRole('listitem', { name: 'API 문서화' })
  await row.waitFor()
  check(/진행 \d+%/.test(await row.textContent()) && /민지 12시간 · \d+%/.test(await row.textContent()), 'list shows the task progress and each share')
  await p.getByRole('listitem', { name: '릴리스 노트' }).getByRole('button').first().click()
  const ed = p.getByRole('dialog', { name: '업무 편집' })
  const splitBtn = ed.getByRole('button', { name: '민지 몫 AI로 세분화' })
  await ed.getByLabel('예상 시간 (시간)').fill('3')
  check((await splitBtn.isDisabled()) && (await ed.getByText('바꾼 내용을 저장한 뒤 세분화할 수 있어요').isVisible()), 'unsaved edits come first')
  await ed.getByLabel('예상 시간 (시간)').fill('2')
  await splitBtn.click()
  const dlg = p.getByRole('dialog', { name: 'AI 세분화' })
  await dlg.getByRole('region', { name: '하위 업무' }).waitFor()
  check((await dlg.textContent()).includes('민지 몫 2시간'), 'the dialog says whose share it is')
  await dlg.getByRole('button', { name: /확인하고 Brain Dump에 추가/ }).click()
  await dlg.waitFor({ state: 'detached' })
  await ed.getByRole('status').waitFor()
  check((await ed.getByRole('status').textContent()).startsWith('민지:') && (await ed.getByText(/Brain Dump 2시간 중 0분 완료/).isVisible()), 'back in the editor: done message and her new progress')
  check((await ed.getByRole('button', { name: '민지 몫 AI로 세분화' }).textContent()).includes('다시 세분화'), 'the button now offers a resplit')
  await ed.getByRole('button', { name: '닫기' }).click()
  check((await taskNow(solo.id)).assignees[0].split, 'saved for minji')

  // 8. Minji only gets the button for her own share
  const mp = await pageAs(minji.cookie)
  await mp.goto(`${BASE}/team/${team.id}`)
  await mp.getByRole('button', { name: '목록' }).click()
  await mp.getByRole('listitem', { name: 'API 문서화' }).getByRole('button').first().click()
  const med = mp.getByRole('dialog', { name: '업무 편집' })
  await med.waitFor()
  check((await med.getByRole('button', { name: '민지 몫 AI로 세분화' }).count()) === 1 && (await med.getByRole('button', { name: '준 몫 AI로 세분화' }).count()) === 0, "a member sees the split only for her own share")

  // 9. Deleting the team task leaves her own items alone
  await call('DELETE', `/teams/${team.id}/tasks/${api.id}`, null, lead.cookie)
  check((await call('GET', '/tasks', null, minji.cookie)).body.items.some((i) => i.title === 'API 문서화'), "deleting the team task keeps minji's backlog item and pieces")

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  await dropTeam?.().catch(() => {})
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
  smtp.server.close()
}
process.exit(failed() ? 1 : 0)
