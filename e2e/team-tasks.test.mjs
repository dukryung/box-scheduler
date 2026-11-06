// Team tasks: everyone sees them; members add their own and move the status of
// what they are on; managers and the owner edit everything and assign anyone.
// List and board views, the editor, filters, and the phone layout.
import { BASE, call, checker, launch, removeUser, watchErrors } from './lib.mjs'
import { startFakeSMTP } from './fake-smtp.mjs'

const { check, failed } = checker()
const errors = []
const smtp = await startFakeSMTP()
const browser = await launch()
const tag = Date.now().toString(36)
const cleanup = []
const pw = 'task-pass-1234'
let teamCleanup = null

const signup = async (who, name) => {
  const r = await call('POST', '/auth/signup', { email: `${who}-${tag}@e2e.test`, password: pw, name })
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
const pageAs = async (who, opts = {}) => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true, ...opts })
  watchErrors(p, errors)
  await p.context().addCookies([{ name: 'bs_session', value: who.cookie, url: BASE }])
  return p
}

try {
  // A team: lead (owner), mina (manager), minji and jun (members); eve is outside.
  const lead = await signup('lead', '팀장')
  const mina = await signup('mina', '미나')
  const minji = await signup('minji', '민지')
  const jun = await signup('jun', '준')
  const eve = await signup('eve', '이브')
  const team = (await call('POST', '/teams', { name: `업무팀 ${tag}` }, lead.cookie)).body
  for (const [who, role] of [
    [mina, 'manager'],
    [minji, 'member'],
    [jun, 'member'],
  ]) {
    await call('POST', `/teams/${team.id}/invites`, { emails: [who.email], role }, lead.cookie)
    const token = (await linkFor(who.email)).split('/invite/')[1]
    await call('POST', `/invites/${token}/accept`, null, who.cookie)
  }
  teamCleanup = () => call('DELETE', `/teams/${team.id}`, { confirm: team.name }, lead.cookie)
  const T = (who, method, path = '', body) => call(method, `/teams/${team.id}/tasks${path}`, body, who.cookie)

  // 1. The owner makes a task with two people on it
  let r = await T(lead, 'POST', '', {
    title: 'API 문서화',
    note: '엔드포인트별 예시 포함',
    startDate: '2026-10-27',
    dueDate: '2026-11-07',
    estimateBoxes: 120,
    assignees: [
      { userId: minji.id, boxes: 72 },
      { userId: jun.id, boxes: 48 },
    ],
  })
  const api = r.body
  check(r.status === 201 && api.assignees.length === 2 && api.assignees.find((a) => a.userId === minji.id)?.boxes === 72 && api.status === 'todo', 'owner creates a task with two assignees and their shares')
  r = await T(lead, 'POST', '', { title: '배포 스크립트 정리', estimateBoxes: 18 })
  const deploy = r.body
  check(r.status === 201 && deploy.assignees.length === 0, 'a manager+ task can start with no one on it')

  // 2. Members see everything, edit only what they may
  const listed = (await T(minji, 'GET')).body.tasks
  const seen = listed.find((t) => t.id === api.id)
  check(listed.length === 2 && seen && !seen.canEdit && seen.canSetStatus, 'member sees all tasks; on API 문서화 she may move the status only')
  r = await T(minji, 'PATCH', `/${api.id}`, { status: 'doing' })
  check(r.status === 200 && r.body.status === 'doing', 'assignee moves the status')
  check((await T(minji, 'PATCH', `/${api.id}`, { title: 'hack' })).status === 403, "member cannot edit someone else's task")
  check((await T(minji, 'PATCH', `/${deploy.id}`, { status: 'doing' })).status === 403, 'member cannot move the status of a task she is not on')
  check((await T(minji, 'DELETE', `/${api.id}`)).status === 403, "member cannot delete someone else's task")

  // 3. Members create their own tasks, with only themselves on them
  r = await T(minji, 'POST', '', { title: '로그인 화면 개선', estimateBoxes: 36 })
  const login = r.body
  check(r.status === 201 && login.assignees.length === 1 && login.assignees[0].userId === minji.id && login.canEdit, 'member task: she is put on it and may edit it')
  check((await T(minji, 'POST', '', { title: 'x', assignees: [{ userId: jun.id, boxes: null }] })).status === 403, 'member cannot assign others')
  r = await T(minji, 'PATCH', `/${login.id}`, { title: '로그인 화면 개선 (모바일)', assignees: [{ userId: minji.id, boxes: 30 }] })
  check(r.status === 200 && r.body.title.endsWith('(모바일)') && r.body.assignees[0].boxes === 30, 'member edits her own task and her share')
  check((await T(minji, 'PATCH', `/${login.id}`, { assignees: [{ userId: minji.id, boxes: 30 }, { userId: jun.id, boxes: 6 }] })).status === 403, 'member cannot add others to her task')

  // 4. Managers assign anyone; a member's later edit keeps those others
  r = await T(mina, 'PATCH', `/${login.id}`, { assignees: [{ userId: minji.id, boxes: 30 }, { userId: jun.id, boxes: 6 }] })
  check(r.status === 200 && r.body.assignees.length === 2, 'manager adds jun to minji’s task')
  r = await T(minji, 'PATCH', `/${login.id}`, { assignees: [{ userId: minji.id, boxes: 24 }] })
  check(r.status === 200 && r.body.assignees.length === 2 && r.body.assignees.find((a) => a.userId === jun.id)?.boxes === 6, "member changing her own share leaves jun's in place")
  r = await T(mina, 'PATCH', `/${deploy.id}`, { assignees: [{ userId: mina.id, boxes: 18 }], status: 'done' })
  check(r.status === 200 && r.body.doneAt && r.body.assignees[0].userId === mina.id, 'manager edits any task; done gets a time')
  r = await T(mina, 'PATCH', `/${deploy.id}`, { status: 'todo' })
  check(r.body.doneAt === null, 'reopening clears it')

  // 5. Checks
  check((await T(lead, 'POST', '', { title: '기간 오류', startDate: '2026-11-08', dueDate: '2026-11-07' })).status === 400, 'start after due is refused')
  check((await T(lead, 'POST', '', { title: '외부인', assignees: [{ userId: eve.id, boxes: null }] })).status === 400, 'outsiders cannot be assigned')
  check((await T(lead, 'POST', '', { title: '', estimateBoxes: 6 })).status === 400, 'a title is required')
  check((await T(lead, 'PATCH', `/${api.id}`, { dueDate: '' })).body.dueDate === null, 'an empty date clears it')
  await T(lead, 'PATCH', `/${api.id}`, { dueDate: '2026-11-07' })
  check((await T(eve, 'GET')).status === 404, 'outsiders cannot see team tasks')

  // 6. Someone leaving: their assignments go, the tasks stay
  await call('DELETE', `/teams/${team.id}/members/${jun.id}`, null, lead.cookie)
  const after = (await T(lead, 'GET')).body.tasks
  check(after.length === 3 && after.every((t) => t.assignees.every((a) => a.userId !== jun.id)), 'jun left: his assignments are gone, the tasks remain')

  // 7. The owner in the browser: tasks tab, create from the editor
  const p = await pageAs(lead)
  await p.goto(`${BASE}/team/${team.id}`)
  await p.getByRole('tab', { name: '업무', selected: true }).waitFor()
  await p.getByRole('list', { name: '업무 목록' }).getByRole('listitem', { name: 'API 문서화' }).waitFor()
  check((await p.getByRole('listitem', { name: 'API 문서화' }).textContent()).includes('10/27 ~ 11/7'), 'list shows the period')
  await p.getByRole('button', { name: '업무', exact: true }).click()
  const dlg = p.getByRole('dialog', { name: '새 업무' })
  await dlg.getByLabel('제목').fill('QA 체크리스트')
  await dlg.getByLabel('시작일').fill('2026-11-02')
  await dlg.getByLabel('마감일').fill('2026-11-04')
  await dlg.getByLabel('예상 시간 (시간)').fill('6')
  await dlg.getByRole('checkbox', { name: /민지/ }).check()
  await dlg.getByLabel('민지 맡은 시간').fill('4')
  await dlg.getByRole('checkbox', { name: /미나/ }).check()
  await dlg.getByLabel('미나 맡은 시간').fill('2.5')
  check(await dlg.getByText(/합계 6시간 30분/).isVisible(), 'editor warns when the shares do not add up')
  await dlg.getByLabel('미나 맡은 시간').fill('2')
  await dlg.getByRole('button', { name: '만들기' }).click()
  await dlg.waitFor({ state: 'detached' })
  const qaRow = p.getByRole('listitem', { name: 'QA 체크리스트' })
  await qaRow.waitFor()
  check((await qaRow.textContent()).includes('민지 4시간') && (await qaRow.textContent()).includes('미나 2시간'), 'new task listed with each share')

  // 8. Filters
  await p.getByRole('button', { name: '담당자 없음' }).click()
  check(await p.getByText('조건에 맞는 업무가 없어요').isVisible(), 'no unassigned tasks now')
  await p.getByRole('button', { name: '전체' }).click()
  await p.getByLabel('상태 필터').selectOption('doing')
  check((await p.getByRole('list', { name: '업무 목록' }).getByRole('listitem').allTextContents()).every((t) => t.includes('API 문서화')), 'status filter: only 진행 중')
  await p.getByLabel('상태 필터').selectOption('all')

  // 9. Board: drag a card to another column
  await p.getByRole('button', { name: '보드' }).click()
  const todoCol = p.getByRole('region', { name: /^할 일/ })
  const doingCol = p.getByRole('region', { name: /^진행 중/ })
  await todoCol.getByRole('article', { name: 'QA 체크리스트' }).dragTo(doingCol)
  await doingCol.getByRole('article', { name: 'QA 체크리스트' }).waitFor()
  await p.waitForTimeout(300)
  const qa = (await T(lead, 'GET')).body.tasks.find((t) => t.title === 'QA 체크리스트')
  check(qa.status === 'doing', 'dragging to 진행 중 saves the status')
  await p.reload()
  await p.getByRole('region', { name: /^진행 중/ }).waitFor()
  check(true, 'the board view is remembered')

  // 10. Minji: someone else's task opens read-only, status still hers to move
  const mp = await pageAs(minji)
  await mp.goto(`${BASE}/team/${team.id}`)
  await mp.getByRole('button', { name: '목록' }).click()
  await mp.getByRole('listitem', { name: 'API 문서화' }).getByRole('button').first().click()
  const view = mp.getByRole('dialog', { name: '업무 편집' })
  await view.waitFor()
  check((await view.getByLabel('제목').isDisabled()) && (await view.getByText('담당자라서 상태만 바꿀 수 있어요').isVisible()), 'read-only for her, says why')
  await view.getByLabel('상태').selectOption('done')
  await view.getByRole('button', { name: '저장' }).click()
  await view.waitFor({ state: 'detached' })
  check((await T(lead, 'GET')).body.tasks.find((t) => t.id === api.id).status === 'done', 'she marks it done from the editor')
  check((await mp.getByRole('button', { name: 'API 문서화 삭제' }).count()) === 0, 'no delete for her: no trash on a task she may not edit')

  // 11. Delete from the list, with confirmation; the editor has no delete
  await p.getByRole('button', { name: '목록' }).click()
  const row = p.getByRole('listitem', { name: '배포 스크립트 정리' })
  await row.getByRole('button').first().click()
  check((await p.getByRole('dialog', { name: '업무 편집' }).getByRole('button', { name: '삭제' }).count()) === 0, 'the editor has no delete button')
  await p.getByRole('dialog', { name: '업무 편집' }).getByRole('button', { name: '닫기' }).click()
  await row.getByRole('button', { name: '배포 스크립트 정리 삭제' }).click()
  await row.getByRole('alertdialog', { name: '삭제 확인' }).getByRole('button', { name: '취소' }).click()
  check((await row.getByRole('alertdialog').count()) === 0 && (await T(lead, 'GET')).body.tasks.length === 4, 'the trash asks first; 취소 keeps it')
  await row.getByRole('button', { name: '배포 스크립트 정리 삭제' }).click()
  await row.getByRole('button', { name: '지우기' }).click()
  await row.waitFor({ state: 'detached' })
  check((await T(lead, 'GET')).body.tasks.length === 3, 'deleted from the list after confirming')

  // 12. Phone: list only, nothing sideways
  const ph = await pageAs(lead, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await ph.goto(`${BASE}/team/${team.id}`)
  await ph.getByRole('list', { name: '업무 목록' }).waitFor()
  check((await ph.getByRole('group', { name: '보기 방식' }).count()) === 0, 'phone: list only (no board switch)')
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no sideways scroll')
  await ph.getByRole('banner').getByRole('link', { name: '팀 설정' }).tap()
  await ph.getByRole('region', { name: /멤버 3/ }).waitFor()
  check(true, 'phone: members open from 팀 설정')

  check(errors.filter((x) => !/40[034]/.test(x)).length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  await teamCleanup?.().catch(() => {})
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
  smtp.server.close()
}
process.exit(failed() ? 1 : 0)
