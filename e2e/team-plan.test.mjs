// "AI로 업무 나누기": a team task is split as a whole into subtasks the team can
// see, each given to one of its people to fit their shares; confirming spreads
// each person's subtasks over their own days into their Brain Dump. Progress
// rolls up per subtask; splitting again keeps what has started.
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
  const r = await call('POST', '/auth/signup', { email: `${who}-${tag}@e2e.test`, password: 'plan-pass-1234', name })
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
const pageAs = async (cookie, opts = {}) => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true, ...opts })
  watchErrors(p, errors)
  await p.context().addCookies([{ name: 'bs_session', value: cookie, url: BASE }])
  return p
}

try {
  // The test owner (server AI) leads; minji and seojun share the work; jun is in the team but not on it.
  await json('GET', '/auth/me')
  const lead = { cookie: (await call('POST', '/auth/login', { email: OWNER.email, password: OWNER.password })).cookie }
  lead.id = (await call('GET', '/auth/me', null, lead.cookie)).body.id
  await call('POST', '/auth/onboarded', null, lead.cookie)
  const minji = await signup('pminji', '민지')
  const seojun = await signup('pseojun', '서준')
  const jun = await signup('pjun', '준')
  const team = (await call('POST', '/teams', { name: `나누기팀 ${tag}` }, lead.cookie)).body
  dropTeam = () => call('DELETE', `/teams/${team.id}`, { confirm: team.name }, lead.cookie)
  for (const who of [minji, seojun, jun]) {
    await call('POST', `/teams/${team.id}/invites`, { emails: [who.email], role: 'member' }, lead.cookie)
    await call('POST', `/invites/${(await linkFor(who.email)).split('/invite/')[1]}/accept`, null, who.cookie)
  }
  const T = (who, method, path, body) => call(method, `/teams/${team.id}/tasks${path}`, body, who.cookie)
  const api = (await T(lead, 'POST', '', { title: 'API 문서화', startDate: today, dueDate: due, estimateBoxes: 120, assignees: [{ userId: minji.id, boxes: 72 }, { userId: seojun.id, boxes: 48 }] })).body
  const P = (who, task, path, body) => T(who, 'POST', `/${task.id}/plan${path}`, { today, now: hm, ...body })
  const taskNow = async (id) => (await T(lead, 'GET', '')).body.tasks.find((t) => t.id === id)

  // 1. Who may split it
  check(api.canPlan, 'the creator may split it')
  check((await T(minji, 'GET', '')).body.tasks[0].canPlan && !(await T(jun, 'GET', '')).body.tasks[0].canPlan, 'an assignee may; a teammate not on it may not')
  check((await P(jun, api, '/preview', { subtasks: [] })).status === 403, 'refused for someone not on the task')
  check((await P(minji, api, '/preview', { subtasks: [{ title: '규격', boxes: 6, assigneeId: minji.id }] })).status === 200, 'an assignee (member) can work on the split')
  const noDue = (await T(lead, 'POST', '', { title: '기한 없음', assignees: [{ userId: minji.id, boxes: 6 }] })).body
  check((await P(lead, noDue, '', {})).body.error?.includes('마감일'), 'needs a due date')
  const nobody = (await T(lead, 'POST', '', { title: '담당 없음', dueDate: due })).body
  check((await P(lead, nobody, '', {})).body.error?.includes('담당자'), 'needs assignees')

  // 2. The AI splits the whole task; the parts are given out to fit the shares
  let r = await P(lead, api, '', {})
  const sum = (who) => r.body.subtasks.filter((s) => s.assigneeId === who).reduce((n, s) => n + s.boxes, 0)
  check(r.status === 200 && r.body.subtasks.length === 3 && r.body.subtasks.reduce((n, s) => n + s.boxes, 0) === 120, `AI splits all 20 hours (${r.body.subtasks?.length} parts)`)
  check(sum(minji.id) === 72 && sum(seojun.id) === 48, `given out to fit 12h / 8h (${sum(minji.id)} / ${sum(seojun.id)} boxes)`)
  const pm = r.body.people.find((p) => p.userId === minji.id)
  check(pm.new === 72 && pm.share === 72 && pm.shortage === 0 && pm.from >= today && pm.to <= due, "each person's part fits their own days")
  check((await P(lead, api, '/preview', { subtasks: [{ title: 'x', boxes: 6, assigneeId: jun.id }] })).status === 400, 'only people on the task can be given a part')

  // 3. Confirm an edited split
  const plan = [
    { title: '공통 규격 정리', boxes: 12, assigneeId: minji.id },
    { title: '로그인 API 문서', boxes: 24, assigneeId: minji.id },
    { title: '사용자 API 문서', boxes: 36, assigneeId: minji.id },
    { title: '이벤트 API 문서', boxes: 48, assigneeId: seojun.id },
  ]
  r = await P(lead, api, '/apply', { subtasks: plan })
  const subs = r.body.task.subtasks
  check(r.status === 200 && subs.length === 4 && subs.map((x) => x.title).join() === plan.map((x) => x.title).join() && subs[3].assigneeId === seojun.id, 'the team task now lists its 4 subtasks with owners')
  const mBacklog = (await call('GET', '/tasks', null, minji.cookie)).body.items.find((i) => i.title === 'API 문서화')
  check(mBacklog?.estimateBoxes === 72 && mBacklog.pieces > 0, "minji's backlog stands for her 12 hours, with pieces")
  const mDays = r.body.people.find((p) => p.userId === minji.id)
  const firstDay = (await call('GET', `/days/${mDays.from}`, null, minji.cookie)).body.brainDump.filter((i) => i.parentId === mBacklog.id)
  check(firstDay.length > 0 && firstDay.every((i) => i.title.startsWith('API 문서화 · ')) && firstDay[0].title.endsWith('공통 규격 정리'), `her first day starts with the first subtask (${firstDay[0]?.title})`)
  check((await call('GET', '/tasks', null, seojun.cookie)).body.items.find((i) => i.title === 'API 문서화')?.pieces > 0, 'seojun got his part too')
  const notes = (await call('GET', '/notifications', null, seojun.cookie)).body.items
  check(notes.some((n) => n.kind === 'subtasks' && n.title === '‘API 문서화’ 하위 업무 1개를 맡았어요' && n.body.includes('이벤트 API 문서')), 'seojun is told what he got')

  // 4. Progress per subtask
  const firstPiece = firstDay[0]
  await call('PATCH', `/brain-dump/${firstPiece.id}`, { status: 'done' }, minji.cookie)
  let st = (await taskNow(api.id)).subtasks.find((x) => x.title === '공통 규격 정리')
  check(st.doneBoxes === firstPiece.estimateBoxes && st.started && (st.status === 'doing' || st.status === 'done'), `finishing a piece moves its subtask (${st.status}, ${st.doneBoxes} boxes)`)
  // finish all of 공통 규격 정리
  const allMine = []
  for (let d = new Date(now); iso(d) <= due; d.setDate(d.getDate() + 1)) allMine.push(...(await call('GET', `/days/${iso(d)}`, null, minji.cookie)).body.brainDump.filter((i) => i.parentId === mBacklog.id))
  for (const i of allMine.filter((i) => i.title.endsWith('공통 규격 정리') && i.status !== 'done')) await call('PATCH', `/brain-dump/${i.id}`, { status: 'done' }, minji.cookie)
  st = (await taskNow(api.id)).subtasks.find((x) => x.title === '공통 규격 정리')
  check(st.status === 'done', 'all its pieces done: the subtask is done')

  // 5. Splitting again keeps what started, replaces the rest (and their pieces)
  const login = allMine.find((i) => i.title.endsWith('로그인 API 문서'))
  await call('PATCH', `/brain-dump/${login.id}`, { status: 'done' }, minji.cookie)
  r = await P(lead, api, '', {})
  check(r.body.kept.map((x) => x.title).sort().join() === '공통 규격 정리,로그인 API 문서', 'a new split shows the started subtasks as kept')
  r = await P(lead, api, '/apply', { subtasks: [{ title: '예시 요청 정리', boxes: 24, assigneeId: seojun.id }] })
  const after = r.body.task.subtasks.map((x) => x.title)
  check(after.join() === '공통 규격 정리,로그인 API 문서,예시 요청 정리', `kept ones first, the rest replaced (${after.join(', ')})`)
  const left = []
  for (let d = new Date(now); iso(d) <= due; d.setDate(d.getDate() + 1)) left.push(...(await call('GET', `/days/${iso(d)}`, null, minji.cookie)).body.brainDump.filter((i) => i.parentId === mBacklog.id))
  check(!left.some((i) => i.title.endsWith('사용자 API 문서')) && left.some((i) => i.title.endsWith('로그인 API 문서') && i.status === 'open'), "the dropped subtask's pieces left her Brain Dump; started ones' remain")

  // 6. Someone leaving: their subtasks stay, without an owner
  await call('DELETE', `/teams/${team.id}/members/${seojun.id}`, null, lead.cookie)
  check((await taskNow(api.id)).subtasks.find((x) => x.title === '예시 요청 정리').assigneeId === '', "seojun left: his subtask has no owner")

  // 7. Browser: split a task from the editor
  const rel = (await T(lead, 'POST', '', { title: '릴리스 준비', startDate: today, dueDate: due, estimateBoxes: 12, assignees: [{ userId: minji.id, boxes: 6 }, { userId: jun.id, boxes: 6 }] })).body
  const p = await pageAs(lead.cookie)
  await p.goto(`${BASE}/team/${team.id}`)
  await p.getByRole('button', { name: '목록' }).click()
  await p.getByRole('listitem', { name: '릴리스 준비' }).getByRole('button').first().click()
  const ed = p.getByRole('dialog', { name: '업무 편집' })
  const planBtn = ed.getByRole('button', { name: 'AI로 업무 나누기' })
  await ed.getByLabel('예상 시간 (시간)').fill('3')
  check((await planBtn.isDisabled()) && (await ed.getByText('바꾼 내용을 저장한 뒤 나눌 수 있어요.').isVisible()), 'unsaved edits come first')
  await ed.getByLabel('예상 시간 (시간)').fill('2')
  await planBtn.click()
  const dlg = p.getByRole('dialog', { name: '업무 나누기' })
  await dlg.getByRole('listitem', { name: '본 작업' }).waitFor()
  check((await dlg.getByLabel('하위 업무 이름').count()) === 3, 'the AI split opens with 3 parts and owners')
  await dlg.getByLabel('검토와 마무리 담당자').selectOption({ label: '민지' })
  await p.waitForTimeout(900)
  const minjiCard = await dlg.getByRole('region', { name: '사람별 배정' }).getByRole('listitem', { name: '민지' }).textContent()
  check(/\d/.test(minjiCard) && minjiCard.includes('맡은 1시간'), `person summary follows the change (${minjiCard})`)
  await dlg.getByRole('button', { name: '확정하고 각자 Brain Dump에 넣기' }).click()
  await dlg.waitFor({ state: 'detached' })
  await ed.getByRole('status').waitFor()
  check((await ed.getByRole('region', { name: '하위 업무' }).getByRole('listitem').count()) === 3 && (await ed.getByRole('button', { name: '업무 다시 나누기' }).isVisible()), 'back in the editor: the subtasks and 다시 나누기')
  await ed.getByRole('button', { name: '닫기' }).click()
  check(/하위 0\/3/.test(await p.getByRole('listitem', { name: '릴리스 준비' }).textContent()), 'the list shows the subtask count')
  check((await taskNow(rel.id)).subtasks.length === 3, 'saved')

  // 8. Someone not on a task sees its subtasks but no split button
  const jp = await pageAs(jun.cookie)
  await jp.goto(`${BASE}/team/${team.id}`)
  await jp.getByRole('button', { name: '목록' }).click()
  await jp.getByRole('listitem', { name: 'API 문서화' }).getByRole('button').first().click()
  const jed = jp.getByRole('dialog', { name: '업무 편집' })
  await jed.waitFor()
  check((await jed.getByRole('button', { name: /업무 (다시 )?나누기/ }).count()) === 0 && (await jed.getByRole('region', { name: '하위 업무' }).getByRole('listitem').count()) === 3, 'others see the subtasks but cannot split')

  // 9. Phone: the dialog fits
  const ph = await pageAs(minji.cookie, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await ph.goto(`${BASE}/team/${team.id}`)
  await ph.getByRole('listitem', { name: '릴리스 준비' }).getByRole('button').first().tap()
  await ph.getByRole('button', { name: '업무 다시 나누기' }).tap()
  await ph.getByRole('dialog', { name: '업무 나누기' }).getByRole('region', { name: '사람별 배정' }).waitFor()
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: the split dialog fits')

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  await dropTeam?.().catch(() => {})
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
  smtp.server.close()
}
process.exit(failed() ? 1 : 0)
