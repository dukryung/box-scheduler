// "Google로 계속하기": new accounts, returning sign-in, linking from 설정, and the refusals.
import { BASE, call, checker, json, launch, watchErrors } from './lib.mjs'
import { startFakeGoogle } from './fake-google.mjs'

const { check, failed } = checker()
const errors = []
const fake = await startFakeGoogle()
const browser = await launch()
const tag = Date.now().toString(36)
const cleanup = []
const google = (who) => ({ sub: `sub-${who}-${tag}`, email: `${who}-${tag}@gmail.test`, name: who })

const signedOutPage = async () => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  watchErrors(p, errors)
  return p
}
const me = async (page) => page.evaluate(() => fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)))

try {
  check((await call('GET', '/auth/providers')).body.google === true, 'server reports Google sign-in on')

  // 1. A new Google account gets an account and lands on today, back where it started
  fake.next = google('gina')
  const p = await signedOutPage()
  await p.goto(`${BASE}/month/2026-12`)
  await p.getByRole('link', { name: 'Google로 계속하기' }).click()
  await p.waitForURL('**/month/2026-12')
  const gina = await me(p)
  check(gina?.email === fake.next.email && gina.google && !gina.hasPassword && gina.name === 'gina', 'Google sign-up: account made, no password, back on the month page')
  cleanup.push(gina.id)

  // 2. Signing in again finds the same account
  await p.goto(`${BASE}/settings`)
  await p.getByRole('button', { name: '로그아웃' }).click()
  await p.waitForURL('**/login')
  await p.getByRole('link', { name: 'Google로 계속하기' }).click()
  await p.waitForURL('**/day/**')
  check((await me(p))?.id === gina.id, 'second Google sign-in → same account')
  check((await json('GET', `/admin/users?q=gina-${tag}`)).users.length === 1, 'still one account')

  // 3. A Google-only account can add a password, then unlink Google
  await p.goto(`${BASE}/settings`)
  await p.getByRole('heading', { name: '로그인 방법' }).waitFor()
  check(await p.getByText('없음 (아래에서 정할 수 있어요)').isVisible(), 'settings: no password yet')
  check((await p.getByRole('button', { name: '연결 끊기' }).count()) === 0, 'cannot unlink Google without a password')
  await p.getByLabel('새 비밀번호 (8자 이상)').fill('gina-pass-12')
  await p.getByRole('button', { name: '비밀번호 정하기' }).click()
  await p.getByText('이제 이메일로도 로그인할 수 있어요').waitFor()
  check((await call('POST', '/auth/login', { email: gina.email, password: 'gina-pass-12' })).status === 200, 'password set without a current one works')
  await p.getByRole('button', { name: '연결 끊기' }).click()
  await p.getByText('Google 연결을 끊었어요').waitFor()
  check((await me(p)).google === false, 'Google unlinked')
  await p.close()

  // 4. Same email as a password account: not joined automatically
  const pat = { email: `pat-${tag}@gmail.test`, password: 'pat-pass-123', name: 'pat' }
  const patAcc = await call('POST', '/auth/signup', pat)
  cleanup.push(patAcc.body.id)
  fake.next = { sub: `sub-pat-${tag}`, email: pat.email, name: 'pat' }
  const q = await signedOutPage()
  await q.goto(`${BASE}/login`)
  await q.getByRole('link', { name: 'Google로 계속하기' }).click()
  await q.getByText('이 이메일로 가입된 계정이 이미 있어요').waitFor()
  check(q.url().includes('error=google_email_exists') && (await me(q)) === null, 'same-email Google sign-in refused, not signed in')

  // 5. …but pat can link it from 설정 after signing in with the password
  await q.getByLabel('이메일').fill(pat.email)
  await q.getByLabel('비밀번호').fill(pat.password)
  await q.getByRole('button', { name: '로그인', exact: true }).click()
  await q.waitForURL('**/day/**')
  await q.goto(`${BASE}/settings`)
  await q.getByRole('link', { name: 'Google 연결하기' }).click()
  await q.getByText('Google 계정을 연결했어요').waitFor()
  check((await me(q)).google === true, 'linked from 설정')
  await q.getByRole('button', { name: '로그아웃' }).click()
  await q.waitForURL('**/login')
  await q.getByRole('link', { name: 'Google로 계속하기' }).click()
  await q.waitForURL('**/day/**')
  check((await me(q))?.id === patAcc.body.id, 'now Google signs pat in')

  // 6. A Google account already linked elsewhere cannot be linked again
  const sam = await call('POST', '/auth/signup', { email: `sam-${tag}@e2e.test`, password: 'sam-pass-123' })
  cleanup.push(sam.body.id)
  const s = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  await s.context().addCookies([{ name: 'bs_session', value: sam.cookie, url: BASE }])
  await s.goto(`${BASE}/settings`)
  await s.getByRole('link', { name: 'Google 연결하기' }).click()
  await s.getByText('이미 다른 계정에 연결돼 있어요').waitFor()
  check((await me(s)).google === false, "pat's Google not linked to sam")
  await s.close()
  await q.close()

  // 7. Cancelled, unverified and tampered sign-ins are refused
  const r = await signedOutPage()
  fake.next = { cancel: true }
  await r.goto(`${BASE}/login`)
  await r.getByRole('link', { name: 'Google로 계속하기' }).click()
  await r.getByText('Google 로그인을 취소했어요').waitFor()
  check(true, 'cancel → message on 로그인')
  fake.next = { ...google('ursula'), verified: false }
  await r.getByRole('link', { name: 'Google로 계속하기' }).click()
  await r.getByText('Google에서 계정을 확인하지 못했어요').waitFor()
  check((await json('GET', `/admin/users?q=ursula-${tag}`)).users.length === 0, 'unverified Google email refused')
  await r.goto(`${BASE}/api/auth/google/callback?code=x&state=forged`)
  await r.getByText('Google 로그인이 만료됐어요').waitFor()
  check((await me(r)) === null, 'forged state refused')
  // A real state from another browser (no matching cookie) is refused too.
  const start = await fetch(`${BASE}/api/auth/google/start`, { redirect: 'manual' })
  const state = new URL(start.headers.get('location')).searchParams.get('state')
  await r.goto(`${BASE}/api/auth/google/callback?code=x&state=${state}`)
  await r.getByText('Google 로그인이 만료됐어요').waitFor()
  check(true, 'state without its cookie refused (login CSRF)')
  const evil = await fetch(`${BASE}/api/auth/google/start?next=//evil.example`, { redirect: 'manual' })
  check(evil.status === 302 && evil.headers.get('location').startsWith('http://localhost:3199/auth?'), 'start sends the browser to Google')
  await r.close()

  // 8. A Google-only account deletes itself by typing its email
  fake.next = google('dora')
  const d = await signedOutPage()
  await d.goto(`${BASE}/login`)
  await d.getByRole('link', { name: 'Google로 계속하기' }).click()
  await d.waitForURL('**/day/**')
  const dora = await me(d)
  await d.goto(`${BASE}/settings`)
  await d.getByRole('button', { name: '계정 삭제' }).click()
  await d.getByLabel('이메일 확인').fill(dora.email)
  await d.getByRole('button', { name: '계정 영구 삭제' }).click()
  await d.waitForURL('**/login')
  check((await json('GET', `/admin/users?q=dora-${tag}`)).users.length === 0, 'Google-only account deleted with its email')
  await d.close()

  check(errors.filter((e) => !e.includes('401')).length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  for (const id of cleanup) await json('DELETE', `/admin/users/${id}`).catch(() => {})
  await browser.close()
  fake.server.close()
}
process.exit(failed() ? 1 : 0)
