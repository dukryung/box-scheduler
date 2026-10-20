// Accounts: sign-up, log-in, isolation between accounts, owner-only AI, and the admin page.
import { BASE, OWNER, call, checker, json, launch, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const browser = await launch()
const D = '2026-11-25'
const tag = Date.now().toString(36)
const alice = { email: `alice-${tag}@e2e.test`, password: 'alice-pass-1', name: '앨리스' }
const bob = { email: `bob-${tag}@e2e.test`, password: 'bob-pass-12', name: '밥' }
const cleanup = []

try {
  // 1. API: sign-up signs in; bad input and duplicates are refused
  const a = await call('POST', '/auth/signup', alice)
  check(a.status === 201 && a.cookie && a.body.role === 'user' && !a.body.isOwner, 'sign-up creates a normal account and signs in')
  cleanup.push(a.body.id)
  check((await call('POST', '/auth/signup', { ...alice, email: alice.email.toUpperCase() })).status === 409, 'same email (any case) refused')
  check((await call('POST', '/auth/signup', { email: 'not-an-email', password: 'long-enough' })).status === 400, 'bad email refused')
  check((await call('POST', '/auth/signup', { email: `short-${tag}@e2e.test`, password: 'short' })).status === 400, 'short password refused')
  const me = await call('GET', '/auth/me', null, a.cookie)
  check(me.status === 200 && me.body.email === alice.email, '/auth/me returns the account')
  check((await call('GET', '/auth/me')).status === 401, 'no cookie → 401')

  // 2. Log-in / log-out
  check((await call('POST', '/auth/login', { email: alice.email, password: 'wrong-password' })).status === 401, 'wrong password → 401')
  const l = await call('POST', '/auth/login', { email: alice.email, password: alice.password })
  check(l.status === 200 && l.cookie && l.cookie !== a.cookie, 'log-in makes a new session')
  await call('POST', '/auth/logout', null, l.cookie)
  check((await call('GET', '/auth/me', null, l.cookie)).status === 401, 'log-out ends that session')
  check((await call('GET', '/auth/me', null, a.cookie)).status === 200, 'other sessions stay signed in')
  let last
  for (let i = 0; i < 11; i++) last = await call('POST', '/auth/login', { email: `nobody-${tag}@e2e.test`, password: 'guess-' + i })
  check(last.status === 429, 'too many failed log-ins for one email → 429')

  // 3. Cross-site style writes are refused
  const raw = await fetch(`${BASE}/api/blocks`, { method: 'POST', headers: { Cookie: `bs_session=${a.cookie}`, 'Content-Type': 'text/plain' }, body: '{}' })
  check(raw.status === 403, 'write without a JSON content type refused (CSRF)')

  // 4. Accounts cannot see or touch each other's data
  const b = await call('POST', '/auth/signup', bob)
  cleanup.push(b.body.id)
  const blk = await call('POST', '/blocks', { date: D, startSlot: 60, endSlot: 66, title: '앨리스 회의' }, a.cookie)
  check(blk.status === 201, 'alice makes a block')
  const bobDay = await call('GET', `/days/${D}`, null, b.cookie)
  check(bobDay.status === 200 && bobDay.body.blocks.length === 0 && bobDay.body.brainDump.length === 0, "bob does not see alice's day")
  check((await call('PATCH', `/blocks/${blk.body.id}`, { title: '해킹' }, b.cookie)).status === 404, "bob cannot edit alice's block")
  check((await call('DELETE', `/blocks/${blk.body.id}`, null, b.cookie)).status === 404, "bob cannot delete alice's block")
  check((await call('GET', `/days/${D}`, null, a.cookie)).body.blocks[0]?.title === '앨리스 회의', "alice's block untouched")
  const ownerDay = await json('GET', `/days/${D}`)
  check(!ownerDay.blocks.some((x) => x.title === '앨리스 회의'), "the owner does not see alice's block either")

  // 5. AI: owner only for now
  const ai = await call('POST', '/assistant/tidy', { text: '음 회의 완료' }, a.cookie)
  check(ai.status === 403 && ai.body.code === 'ai_not_connected', 'non-owner AI call refused with ai_not_connected')
  check((await json('POST', '/assistant/tidy', { text: '음 회의 완료' })).text === '회의 완료', 'owner can use AI')

  // 6. Admin API: only admins; owner and self are protected
  check((await call('GET', '/admin/users', null, a.cookie)).status === 403, 'non-admin cannot open the admin API')
  const list = await json('GET', `/admin/users?q=${tag}`)
  check(list.users.length === 2 && list.users.every((u) => !('passwordHash' in u)), 'admin lists accounts (no password data)')
  const owner = (await json('GET', '/admin/users?q=owner@e2e.test')).users[0]
  check((await call('PATCH', `/admin/users/${owner.id}`, { status: 'suspended' }, (await ownerCookie()))).status === 400, 'owner account cannot be suspended')
  await json('PATCH', `/admin/users/${b.body.id}`, { status: 'suspended' })
  check((await call('GET', '/auth/me', null, b.cookie)).status === 401, 'suspending signs the account out')
  check((await call('POST', '/auth/login', bob)).status === 403, 'suspended account cannot log in')
  await json('PATCH', `/admin/users/${b.body.id}`, { status: 'active' })
  check((await call('POST', '/auth/login', bob)).status === 200, 'restored account can log in')

  // 7. Reset link: one use, signs out elsewhere
  const link = await json('POST', `/admin/users/${a.body.id}/reset-link`)
  const token = new URL(link.path, BASE).searchParams.get('token')
  const r1 = await call('POST', '/auth/reset', { token, password: 'alice-new-pass' })
  check(r1.status === 200 && r1.cookie, 'reset link sets a new password and signs in')
  check((await call('GET', '/auth/me', null, a.cookie)).status === 401, 'older sessions signed out after reset')
  check((await call('POST', '/auth/reset', { token, password: 'again-pass-1' })).status === 400, 'reset link works only once')
  check((await call('POST', '/auth/login', { email: alice.email, password: 'alice-new-pass' })).status === 200, 'new password works')
  const audit = await json('GET', '/admin/audit')
  check(['suspend', 'restore', 'reset-link'].every((x) => audit.entries.some((e) => e.action === x && e.target)), 'admin actions are recorded')

  // 8. Setup cannot be repeated
  check((await call('POST', '/auth/setup', { token: 'e2e-setup-token', ...OWNER })).status !== 200, 'owner setup works only once')

  // 9. Browser: signed out → login page → back to where you were
  const out = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  watchErrors(out, errors)
  await out.goto(`${BASE}/month/2026-11`)
  await out.getByRole('heading', { name: '로그인' }).waitFor()
  check(out.url().includes('/login?next=%2Fmonth%2F2026-11'), 'signed-out visit goes to 로그인 with next')
  await out.getByLabel('이메일').fill(bob.email)
  await out.getByLabel('비밀번호').fill('wrong-password')
  await out.getByRole('button', { name: '로그인' }).click()
  await out.getByRole('alert').waitFor()
  check((await out.getByRole('alert').textContent()).includes('맞지 않아요'), 'wrong password message')
  await out.getByLabel('비밀번호').fill(bob.password)
  await out.getByRole('button', { name: '로그인' }).click()
  await out.waitForURL('**/month/2026-11')
  check(true, 'after log-in, back to the month page')
  await out.getByRole('link', { name: /계정 설정/ }).click()
  await out.getByRole('heading', { name: '설정' }).waitFor()
  check(await out.getByText(bob.email).isVisible(), 'settings shows the email')
  check((await out.getByRole('link', { name: '사용자 관리 (어드민)' }).count()) === 0, 'no admin link for a normal user')
  await out.goto(`${BASE}/admin`)
  check(await out.getByText('어드민만 볼 수 있어요').isVisible(), 'admin page closed to a normal user')
  await out.goto(`${BASE}/settings`)
  await out.getByRole('button', { name: '로그아웃' }).click()
  await out.waitForURL('**/login')
  check(true, 'log-out returns to 로그인')

  // 10. Browser: sign-up page
  await out.getByRole('link', { name: '가입하기' }).click()
  await out.getByRole('heading', { name: '가입하기' }).waitFor()
  const carol = `carol-${tag}@e2e.test`
  await out.getByLabel('이메일').fill(carol)
  await out.getByLabel('비밀번호 (8자 이상)').fill('carol-pass-1')
  await out.getByRole('button', { name: '가입하기' }).click()
  await out.waitForURL('**/day/**')
  check(await out.locator('[title="12:00"]').isVisible(), 'sign-up lands on today’s timetable')
  const carolId = (await json('GET', `/admin/users?q=carol-${tag}`)).users[0]?.id
  if (carolId) cleanup.push(carolId)
  await out.close()

  // 11. Browser: admin page for the owner
  const admin = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  watchErrors(admin, errors)
  await admin.goto(`${BASE}/admin`)
  await admin.getByRole('heading', { name: '사용자 관리' }).waitFor()
  await admin.getByLabel('검색').fill(tag)
  await admin.getByRole('listitem', { name: bob.email }).waitFor()
  const bobRow = admin.getByRole('listitem', { name: bob.email })
  check((await admin.getByRole('region', { name: '사용자 목록' }).getByRole('listitem').count()) === 3, 'search narrows the list')
  check(!(await admin.content()).includes('앨리스 회의'), "no one's schedule contents on the admin page")
  await bobRow.getByRole('button', { name: '정지', exact: true }).click()
  await bobRow.getByText('정지됨').waitFor()
  check(true, 'suspend from the page')
  await bobRow.getByRole('button', { name: '정지 해제' }).click()
  await bobRow.getByRole('button', { name: '비밀번호 재설정 링크' }).click()
  const shown = await bobRow.getByLabel('재설정 링크').inputValue()
  check(shown.startsWith(`${BASE}/reset?token=`), 'reset link shown to copy')
  await bobRow.getByRole('button', { name: '삭제' }).click()
  await bobRow.getByRole('alertdialog').getByRole('button', { name: '삭제' }).click()
  await admin.getByRole('listitem', { name: bob.email }).waitFor({ state: 'detached' })
  check((await call('POST', '/auth/login', bob)).status === 401, 'deleted account is gone')
  check(await admin.getByText('삭제').first().isVisible(), 'audit list shows the delete')
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await phone.goto(`${BASE}/admin`)
  await phone.getByRole('heading', { name: '사용자 관리' }).waitFor()
  check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: admin page has no sideways scroll')

  check(errors.filter((e) => !e.includes('401') && !e.includes('403')).length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  for (const id of cleanup) await json('DELETE', `/admin/users/${id}`).catch(() => {})
  await browser.close()
}
process.exit(failed() ? 1 : 0)

async function ownerCookie() {
  return (await call('POST', '/auth/login', { email: OWNER.email, password: OWNER.password })).cookie
}
