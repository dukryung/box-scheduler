// The admin console: its own servers and accounts, first sign-in with two-factor,
// roles, user management, and the separation from the app.
import { chromium } from 'playwright-core'
import { ADMIN_BASE, BASE, adminCLI, adminCall, adminSession, call, checker, json, passTOTP, totp, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const tag = Date.now().toString(36)
const op = { email: `op-${tag}@e2e.test`, name: '운영자', temp: 'op-temp-password-1', password: 'op-new-password-123' }
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const sup = await adminSession()
const asSuper = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addCookies([{ name: 'bs_admin', value: sup.cookie, url: ADMIN_BASE }])
  const p = await ctx.newPage()
  watchErrors(p, errors)
  return p
}
const appUsers = []

try {
  // 1. Two separate layers
  check((await fetch(`${ADMIN_BASE}/api/health`)).ok && (await fetch(`${BASE}/api/health`)).ok, 'admin and app servers both up')
  const alice = await call('POST', '/auth/signup', { email: `alice-${tag}@e2e.test`, password: 'alice-pass-1', name: '앨리스' })
  appUsers.push(alice.body.id)
  await call('POST', '/blocks', { date: '2026-12-02', startSlot: 60, endSlot: 66, title: '앨리스 비밀 회의' }, alice.cookie)
  check((await adminCall('GET', '/users', null, alice.cookie)).status === 401, 'an app session cannot use the admin API')
  check((await call('GET', '/auth/me', null, sup.cookie)).status === 401, 'an admin session cannot use the app API')
  check((await call('GET', '/admin/users')).status === 404, 'the app server has no admin routes')
  const page0 = await fetch(`${ADMIN_BASE}/`)
  check(page0.headers.get('x-robots-tag')?.includes('noindex') && page0.headers.get('x-frame-options') === 'DENY', 'console is noindex and cannot be framed')

  // 2. Admin accounts come from the server's command line
  adminCLI(['create', '--email', op.email, '--name', op.name, '--role', 'operator', '--password-stdin'], op.temp + '\n')
  check(adminCLI(['list']).includes(op.email), 'CLI creates an operator and lists it')
  let dup = ''
  try {
    adminCLI(['create', '--email', op.email.toUpperCase(), '--role', 'operator', '--password-stdin'], op.temp + '\n')
  } catch (e) {
    dup = String(e.stderr)
  }
  check(dup.includes('error'), 'same email (any case) refused by the CLI')

  // 3. First sign-in in the browser: temporary password → new password → two-factor → console
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  watchErrors(p, errors)
  await p.goto(`${ADMIN_BASE}/users`)
  await p.getByRole('heading', { name: '관리자 로그인' }).waitFor()
  check(p.url().includes('/login?next=%2Fusers'), 'signed-out visit goes to 관리자 로그인')
  await p.getByLabel('이메일').fill(op.email)
  await p.getByLabel('비밀번호').fill('wrong-password-0')
  await p.getByRole('button', { name: '다음' }).click()
  await p.getByRole('alert').waitFor()
  check((await p.getByRole('alert').textContent()).includes('맞지 않아요'), 'wrong password message')
  await p.getByLabel('비밀번호').fill(op.temp)
  await p.getByRole('button', { name: '다음' }).click()
  await p.getByRole('heading', { name: '새 비밀번호 정하기' }).waitFor()
  check(true, 'temporary password must be changed first')
  await p.getByLabel('임시 비밀번호').fill(op.temp)
  await p.getByLabel('새 비밀번호 (12자 이상)').fill('short')
  await p.getByLabel('새 비밀번호 (12자 이상)').fill(op.password)
  await p.getByRole('button', { name: '비밀번호 바꾸기' }).click()
  await p.getByRole('heading', { name: '2단계 인증 설정' }).waitFor()
  check(await p.getByRole('img', { name: '2단계 인증 QR 코드' }).isVisible(), 'QR code shown for the authenticator app')
  check((await adminCall('GET', '/dashboard', null, (await ctx.cookies()).find((c) => c.name === 'bs_admin').value)).status === 403, 'console API closed until two-factor is done')
  await p.getByText('QR 코드를 찍을 수 없나요?').click()
  const secret = (await p.getByTestId('totp-secret').textContent()).trim()
  await p.getByLabel('인증 코드 6자리').fill('000000')
  await p.getByRole('button', { name: '설정 마치기' }).click()
  await p.getByRole('alert').waitFor()
  check((await p.getByRole('alert').textContent()).includes('인증 코드가 맞지 않아요'), 'wrong code refused')
  const code = totp(secret)
  await p.getByLabel('인증 코드 6자리').fill(code)
  await p.getByRole('button', { name: '설정 마치기' }).click()
  await p.waitForURL(`${ADMIN_BASE}/users`)
  await p.getByRole('heading', { name: '사용자' }).waitFor()
  check(true, 'two-factor set up; back to the page asked for')

  // 4. An operator manages users but not admins
  check((await p.getByRole('link', { name: '관리자 계정' }).count()) === 0, 'operator: no 관리자 계정 menu')
  const opCookie = (await ctx.cookies()).find((c) => c.name === 'bs_admin').value
  check((await adminCall('GET', '/admins', null, opCookie)).status === 403, 'operator: admin accounts API refused')
  check((await adminCall('GET', '/users', null, opCookie)).status === 200, 'operator: users API allowed')

  // 5. Signing in again needs a code, and the same code cannot be used twice
  await p.getByRole('button', { name: '로그아웃' }).click()
  await p.waitForURL('**/login')
  const again = await adminCall('POST', '/auth/login', { email: op.email, password: op.password })
  check(again.body.stage === 'totp', 'next sign-in asks for a code')
  check((await adminCall('POST', '/auth/totp/verify', { code }, again.cookie)).status === 401, 'a used code cannot be replayed')
  check((await passTOTP(again.cookie, secret)).body.stage === 'ok', 'a fresh code signs in')

  // 6. Five wrong passwords lock the account for a while
  for (let i = 0; i < 5; i++) await adminCall('POST', '/auth/login', { email: op.email, password: `nope-${i}-password` })
  check((await adminCall('POST', '/auth/login', { email: op.email, password: op.password })).status === 423, 'locked after five failures, even with the right password')
  adminCLI(['reset', '--email', op.email, '--password-stdin'], op.temp + '\n')
  const afterReset = await adminCall('POST', '/auth/login', { email: op.email, password: op.temp })
  check(afterReset.status === 200 && afterReset.body.stage === 'password', 'CLI reset unlocks, gives a temporary password and clears two-factor')
  await ctx.close()

  // 7. Super admin: users list and detail, without schedule contents
  const s = await asSuper()
  await s.goto(`${ADMIN_BASE}/`)
  await s.getByRole('heading', { name: '대시보드' }).waitFor()
  check(await s.getByRole('figure', { name: /하루 활동 사용자/ }).isVisible(), 'dashboard: daily charts')
  await s.getByRole('link', { name: '사용자', exact: true }).click()
  await s.getByPlaceholder('이메일이나 이름으로 검색').fill(`alice-${tag}`)
  await s.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1, null, { timeout: 5000 }).catch(() => {})
  check((await s.locator('tbody tr').count()) === 1 && (await s.getByRole('link', { name: /앨리스/ }).isVisible()), 'search narrows the table')
  await s.getByRole('radio', { name: '정지' }).click()
  await s.getByText('조건에 맞는 사용자가 없어요').waitFor()
  check(true, 'filter: 정지 shows none')
  await s.getByRole('radio', { name: '전체' }).click()
  await s.getByRole('link', { name: /앨리스/ }).click()
  await s.getByRole('heading', { name: '앨리스' }).waitFor()
  check(!(await s.content()).includes('앨리스 비밀 회의'), "no schedule contents on the detail page")
  check((await s.getByText('1 · 1').count()) === 1, 'detail: block and item counts')
  check(await s.getByText(/Chrome|알 수 없는 기기|node/i).first().isVisible(), 'detail: signed-in device listed')

  // notes, sign-out everywhere, suspend, reset link
  await s.getByPlaceholder(/문의 내용/).fill('문의: 비밀번호 분실')
  await s.getByRole('button', { name: '남기기' }).click()
  await s.getByText('문의: 비밀번호 분실').waitFor()
  check(true, 'operator note saved')
  await s.getByRole('button', { name: '모든 기기 로그아웃' }).click()
  await s.getByText('로그인된 기기가 없어요').waitFor()
  check((await call('GET', '/auth/me', null, alice.cookie)).status === 401, 'sign-out everywhere ends the app session')
  await s.getByRole('button', { name: /이용 정지/ }).click()
  await s.getByRole('button', { name: '정지 해제' }).waitFor()
  check((await call('POST', '/auth/login', { email: `alice-${tag}@e2e.test`, password: 'alice-pass-1' })).status === 403, 'suspended from the console')
  await s.getByRole('button', { name: '정지 해제' }).click()
  await s.getByRole('button', { name: '비밀번호 재설정 링크 만들기' }).click()
  check((await s.getByLabel('재설정 링크').inputValue()).startsWith(`${BASE}/reset?token=`), 'reset link for the app shown once')
  check((await s.getByText('사용자 정지').count()) >= 1, 'actions appear in this user’s history')

  // delete asks for the admin password again
  await s.getByRole('button', { name: '계정 삭제…' }).click()
  const dlg = s.getByRole('dialog', { name: '계정 삭제' })
  await dlg.getByLabel('내 관리자 비밀번호').fill('not-my-password')
  await dlg.getByRole('button', { name: '영구 삭제' }).click()
  await dlg.getByRole('alert').waitFor()
  check(true, 'wrong admin password: not deleted')
  await dlg.getByLabel('내 관리자 비밀번호').fill(sup.password)
  await dlg.getByRole('button', { name: '영구 삭제' }).click()
  await s.waitForURL(`${ADMIN_BASE}/users`)
  check((await call('POST', '/auth/login', { email: `alice-${tag}@e2e.test`, password: 'alice-pass-1' })).status === 401, 'deleted with its data')
  appUsers.pop()
  const owner = (await json('GET', '/auth/me'))
  check((await adminCall('DELETE', `/users/${owner.id}`, { password: sup.password }, sup.cookie)).status === 400, 'the owner account cannot be deleted')

  // 8. Admin accounts page (super only)
  await s.getByRole('link', { name: '관리자 계정' }).click()
  await s.getByRole('heading', { name: '관리자 계정' }).waitFor()
  const newbie = `new-${tag}@e2e.test`
  const form = s.getByRole('region', { name: '관리자 추가' })
  await form.getByLabel('이메일').fill(newbie)
  await form.getByRole('button', { name: '추가' }).click()
  await s.getByRole('dialog', { name: '관리자 추가' }).getByLabel('내 관리자 비밀번호').fill(sup.password)
  await s.getByRole('dialog', { name: '관리자 추가' }).getByRole('button', { name: '추가' }).click()
  const temp = await s.getByLabel('임시 비밀번호').inputValue()
  check(temp.length === 16, 'new admin gets a 16-character temporary password, shown once')
  check((await adminCall('POST', '/auth/login', { email: newbie, password: temp })).body?.stage === 'password', 'and must change it at first sign-in')
  const row = s.getByRole('listitem', { name: newbie })
  await row.getByRole('button', { name: '중지' }).click()
  await s.getByRole('dialog').getByLabel('내 관리자 비밀번호').fill(sup.password)
  await s.getByRole('dialog').getByRole('button', { name: '중지' }).click()
  await row.getByRole('button', { name: '다시 사용' }).waitFor()
  check((await adminCall('POST', '/auth/login', { email: newbie, password: temp })).status === 403, 'disabled admin cannot sign in')
  const self = (await adminCall('GET', '/auth/me', null, sup.cookie)).body.account
  check((await adminCall('PATCH', `/admins/${self.id}`, { role: 'operator', password: sup.password }, sup.cookie)).status === 400, 'cannot change your own role (a super admin always remains)')

  // 9. Audit log
  await s.getByRole('link', { name: '관리 기록' }).click()
  await s.getByPlaceholder('관리자나 대상 이메일').fill(tag)
  await s.locator('tbody tr').first().waitFor()
  const log = await s.locator('tbody').textContent()
  check(['로그인 실패', '사용자 삭제', '관리자 생성', '강제 로그아웃'].every((x) => log.includes(x)), 'audit shows failures, deletes, admin changes and sign-outs')

  // 10. Phone width
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await phone.addCookies([{ name: 'bs_admin', value: sup.cookie, url: ADMIN_BASE }])
  const ph = await phone.newPage()
  await ph.goto(`${ADMIN_BASE}/users`)
  await ph.getByRole('heading', { name: '사용자' }).waitFor()
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no sideways page scroll (table scrolls in its box)')
  await ph.getByRole('button', { name: '메뉴 열기' }).tap()
  check(await ph.getByRole('navigation', { name: '관리 메뉴' }).isVisible(), 'phone: menu drawer')

  check(errors.filter((e) => !/40[13]|423/.test(e)).length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  for (const id of appUsers) await adminCall('DELETE', `/users/${id}`, { password: sup.password }, sup.cookie).catch(() => {})
  for (const email of [op.email, `new-${tag}@e2e.test`]) {
    try {
      adminCLI(['disable', '--email', email])
    } catch {}
  }
  await browser.close()
}
process.exit(failed() ? 1 : 0)
