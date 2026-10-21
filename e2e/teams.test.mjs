// Teams: choose personal or team use, create a team, invite by email, join from
// the link (sign-up or log-in, matching email only), roles and their limits.
import { BASE, call, checker, json, launch, removeUser, watchErrors } from './lib.mjs'
import { startFakeSMTP } from './fake-smtp.mjs'

const { check, failed } = checker()
const errors = []
const smtp = await startFakeSMTP()
const browser = await launch()
const tag = Date.now().toString(36)
const cleanup = []
const people = { lead: `lead-${tag}@e2e.test`, minji: `minji-${tag}@e2e.test`, seojun: `seojun-${tag}@e2e.test`, eve: `eve-${tag}@e2e.test` }
const pw = 'team-pass-1234'
const signup = async (email, name) => {
  const r = await call('POST', '/auth/signup', { email, password: pw, name })
  cleanup.push(r.body.id)
  return r
}
const mailTo = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = [...smtp.inbox].reverse().find((x) => x.to.includes(email))
    if (m) return m
    await new Promise((r) => setTimeout(r, 150))
  }
  return null
}
const pageAs = async (cookie, opts = {}) => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true, ...opts })
  watchErrors(p, errors)
  if (cookie) await p.context().addCookies([{ name: 'bs_session', value: cookie, url: BASE }])
  return p
}

try {
  // 1. A new account picks how to use the app; the team path makes a team
  const lead = await signup(people.lead, '팀장')
  check(lead.body.onboarded === false, 'new accounts start not onboarded')
  const p = await pageAs(lead.cookie)
  await p.goto(`${BASE}/day/2026-12-01`)
  await p.getByRole('heading', { name: '어떻게 쓰실 건가요?' }).waitFor()
  check(true, 'new account lands on the choice page')
  await p.getByRole('radio', { name: /팀을 만들게요/ }).click()
  await p.getByLabel('팀 이름').fill(`개발팀 ${tag}`)
  await p.getByRole('button', { name: '팀 만들고 초대하러 가기' }).click()
  await p.waitForURL('**/team/**?invite=1')
  await p.getByRole('heading', { name: new RegExp(`개발팀 ${tag}`) }).waitFor()
  const teamId = new URL(p.url()).pathname.split('/')[2]
  check((await call('GET', '/auth/me', null, lead.cookie)).body.onboarded, 'choosing marks the account onboarded')
  check((await call('GET', `/teams/${teamId}`, null, lead.cookie)).body.role === 'owner', 'the creator is the owner')

  // 2. Invite two people by email (one manager, one member)
  await p.getByLabel('초대할 이메일 1').fill(people.minji)
  await p.getByLabel('초대할 이메일 1').press('Enter')
  check(await p.getByLabel('초대할 이메일 2').evaluate((el) => el === document.activeElement), 'Enter adds a second email box and moves to it')
  await p.getByLabel('초대할 이메일 2').fill('not-an-email')
  await p.getByRole('button', { name: '+ 이메일 추가' }).click()
  await p.getByLabel('초대할 이메일 3').fill('third@e2e.test')
  await p.getByRole('button', { name: '이메일 3 지우기' }).click()
  check((await p.getByLabel(/^초대할 이메일/).count()) === 2, '+ adds a box, × removes it')
  await p.getByRole('button', { name: '2명 초대 보내기' }).click()
  const results = p.getByRole('list', { name: '초대 결과' })
  await results.waitFor()
  check((await results.textContent()).match(/메일을 보냈어요/g)?.length === 1 && (await results.textContent()).includes('이메일 주소를 확인해 주세요'), 'invite sent, the bad address flagged')
  check((await p.getByLabel(/^초대할 이메일/).count()) === 1 && (await p.getByLabel('초대할 이메일 1').inputValue()) === 'not-an-email', 'only the failed address stays to fix')
  await p.getByLabel('초대할 이메일 1').fill(people.seojun)
  await p.getByLabel('역할').selectOption('manager')
  await p.getByRole('button', { name: '초대 보내기' }).click()
  await p.waitForFunction((e) => document.querySelector('[aria-label="초대 결과"]')?.textContent.includes(e), people.seojun)
  const mailMinji = await mailTo(people.minji)
  check(mailMinji?.link?.startsWith(`${BASE}/invite/`) && mailMinji.raw.includes('초대 수락하기'), 'the email carries the invite link')
  check(mailMinji.subject.includes('팀에 초대했어요'), `subject: ${mailMinji?.subject}`)
  await p.getByRole('region', { name: /대기 중인 초대 2/ }).waitFor()
  check(true, 'both show as pending')
  const dup = (await call('POST', `/teams/${teamId}/invites`, { emails: [people.lead], role: 'member' }, lead.cookie)).body.results[0]
  check(dup.error === '이미 팀 멤버예요', 'a current member is not invited')

  // 3. Minji: signs up from the link (email prefilled) and joins
  const m = await pageAs(null)
  await m.goto(mailMinji.link)
  await m.getByText(`‘개발팀 ${tag}’`).first().waitFor()
  check((await m.textContent('main')).includes('일반'), 'invite page shows team, inviter and role')
  await m.getByRole('link', { name: '가입하고 참여하기' }).click()
  await m.getByRole('heading', { name: '가입하기' }).waitFor()
  check((await m.getByLabel('이메일').inputValue()) === people.minji, 'sign-up email prefilled from the invite')
  await m.getByLabel('비밀번호 (8자 이상)').fill(pw)
  await m.getByRole('button', { name: '가입하기' }).click()
  await m.waitForURL('**/invite/**')
  await m.getByRole('button', { name: /팀에 참여하기/ }).click()
  await m.waitForURL(`**/team/${teamId}`)
  await m.getByRole('tab', { name: /멤버/ }).click()
  await m.getByRole('region', { name: /멤버 2/ }).waitFor()
  check(true, 'joined after sign-up and sees the team')
  const minjiMe = (await m.evaluate(() => fetch('/api/auth/me').then((r) => r.json())))
  cleanup.push(minjiMe.id)
  check(minjiMe.onboarded, 'joining from an invite skips the choice page')
  check((await m.getByRole('region', { name: '이메일로 초대하기' }).count()) === 0, 'a member cannot invite')
  const reuse = await m.evaluate((link) => fetch(`/api/invites/${link.split('/invite/')[1]}`).then((r) => r.json()), mailMinji.link)
  check(reuse.status === 'accepted', 'the link is used up')

  // 4. Eve (wrong email) cannot use Seojun's link
  const mailSeojun = await mailTo(people.seojun)
  const eve = await signup(people.eve, '이브')
  await call('POST', '/auth/onboarded', null, eve.cookie)
  const e = await pageAs(eve.cookie)
  await e.goto(mailSeojun.link)
  await e.getByText(/초대받은 이메일과 달라요/).waitFor()
  check((await e.getByRole('button', { name: /팀에 참여하기/ }).count()) === 0, 'another email sees no join button')
  const forced = await call('POST', `/invites/${mailSeojun.link.split('/invite/')[1]}/accept`, null, eve.cookie)
  check(forced.status === 403 && forced.body.code === 'wrong_email', 'and the API refuses it too')
  check((await call('GET', `/teams/${teamId}`, null, eve.cookie)).status === 404, 'outsiders cannot see the team')

  // 5. Seojun already has an account: logs in from the link, joins as manager
  const seojun = await signup(people.seojun, '서준')
  await call('POST', '/auth/onboarded', null, seojun.cookie)
  const sj = await pageAs(null)
  await sj.goto(mailSeojun.link)
  await sj.getByRole('link', { name: /로그인/ }).click()
  await sj.getByLabel('이메일').fill(people.seojun)
  await sj.getByLabel('비밀번호').fill(pw)
  await sj.getByRole('button', { name: '로그인', exact: true }).click()
  await sj.waitForURL('**/invite/**')
  await sj.getByRole('button', { name: /팀에 참여하기/ }).click()
  await sj.waitForURL(`**/team/${teamId}`)
  const team = (await call('GET', `/teams/${teamId}`, null, lead.cookie)).body
  check(team.memberList.length === 3 && team.memberList.find((x) => x.email === people.seojun)?.role === 'manager' && team.invites.length === 0, 'three members; seojun is a manager; no invites left')

  // 6. Role limits
  const asMinji = (method, path, body) => m.evaluate(([mt, pa, bo]) => fetch(`/api${pa}`, { method: mt, headers: { 'Content-Type': 'application/json' }, body: bo && JSON.stringify(bo) }).then((r) => r.status), [method, path, body])
  check((await asMinji('POST', `/teams/${teamId}/invites`, { emails: ['x@e2e.test'], role: 'member' })) === 403, 'member cannot invite')
  check((await asMinji('PATCH', `/teams/${teamId}`, { name: 'hack' })) === 403, 'member cannot rename the team')
  check((await asMinji('DELETE', `/teams/${teamId}/members/${seojun.body.id}`)) === 403, 'member cannot remove others')
  check((await call('PATCH', `/teams/${teamId}/members/${minjiMe.id}`, { role: 'manager' }, seojun.cookie)).status === 403, 'manager cannot change roles (owner only)')
  check((await call('DELETE', `/teams/${teamId}/members/${lead.body.id}`, null, seojun.cookie)).status === 403, 'manager cannot remove the owner')
  const inv = (await call('POST', `/teams/${teamId}/invites`, { emails: [`late-${tag}@e2e.test`], role: 'member' }, seojun.cookie)).body.results[0]
  check(inv.sent, 'manager can invite')
  const pending = (await call('GET', `/teams/${teamId}`, null, seojun.cookie)).body.invites
  const resent = (await call('POST', `/teams/${teamId}/invites/${pending[0].id}/resend`, null, seojun.cookie)).body
  const oldLink = (await mailTo(`late-${tag}@e2e.test`)).link
  check(resent.sent, 'invite resent')
  check((await call('DELETE', `/teams/${teamId}/invites/${pending[0].id}`, null, seojun.cookie)).status === 204, 'manager can cancel an invite')
  check((await call('GET', `/invites/${oldLink.split('/invite/')[1]}`)).body.status === 'revoked', 'a cancelled invite stops working')

  // 7. Owner: change role, switcher, transfer, leave, delete
  await p.goto(`${BASE}/team/${teamId}?tab=members`)
  await p.getByLabel(`${people.minji} 역할`).selectOption('manager')
  await p.waitForTimeout(400)
  check((await call('GET', `/teams/${teamId}`, null, lead.cookie)).body.memberList.find((x) => x.email === people.minji).role === 'manager', 'owner changed minji to manager')
  await p.getByRole('button', { name: new RegExp(`개발팀 ${tag}`) }).click()
  await p.getByRole('menu', { name: '공간 전환' }).getByRole('menuitem', { name: '내 공간' }).click()
  await p.waitForURL('**/day/**')
  check(true, 'space switcher goes back to the personal space')
  check((await call('DELETE', `/teams/${teamId}/members/${lead.body.id}`, null, lead.cookie)).status === 400, 'the owner cannot leave without handing over')
  check((await call('POST', `/teams/${teamId}/transfer`, { userId: seojun.body.id }, lead.cookie)).body.role === 'manager', 'owner handed to seojun; lead is now a manager')
  check((await call('DELETE', `/teams/${teamId}/members/${lead.body.id}`, null, lead.cookie)).status === 204, 'lead can now leave')
  check((await call('DELETE', `/teams/${teamId}`, { confirm: 'wrong' }, seojun.cookie)).status === 400, 'delete needs the team name')
  check((await call('DELETE', `/teams/${teamId}`, { confirm: `개발팀 ${tag}` }, seojun.cookie)).status === 204, 'the owner deletes the team')
  const minjiCookie = (await call('POST', '/auth/login', { email: people.minji, password: pw })).cookie
  check((await call('GET', `/teams/${teamId}`, null, minjiCookie)).status === 404, 'gone for its members too')

  // 8. Personal choice and phone
  const solo = await signup(`solo-${tag}@e2e.test`, '혼자')
  const s = await pageAs(solo.cookie, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await s.goto(`${BASE}/`)
  await s.getByRole('radio', { name: /혼자 쓸게요/ }).tap()
  await s.getByRole('button', { name: '시작하기' }).tap()
  await s.waitForURL('**/day/**')
  check(true, 'personal choice goes straight to today')
  check(await s.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no sideways scroll')

  check(errors.filter((x) => !/40[0134]|410/.test(x)).length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
  smtp.server.close()
}
process.exit(failed() ? 1 : 0)
