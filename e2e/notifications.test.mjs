// Notifications: Web Push to subscribed browsers (checked by decrypting what a
// fake push service receives), reminders 10 minutes before timetable blocks,
// team notifications, the bell and the settings.
import { execFileSync } from 'node:child_process'
import { BASE, call, checker, launch, removeUser, watchErrors } from './lib.mjs'
import { startFakePush } from './fake-push.mjs'
import { startFakeSMTP } from './fake-smtp.mjs'

const { check, failed } = checker()
const errors = []
const push = startFakePush()
const smtp = await startFakeSMTP()
const browser = await launch()
const tag = Date.now().toString(36)
const cleanup = []
let dropTeam = null
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const psql = (sql) =>
  execFileSync('docker', ['compose', '-p', 'boxtest', '--env-file', 'test.env', '-f', '../docker-compose.yml', 'exec', '-T', 'db', 'psql', '-U', 'boxscheduler', '-d', 'boxscheduler', '-tAc', sql], {
    cwd: new URL('.', import.meta.url),
    encoding: 'utf8',
  }).trim()

const signup = async (who, name) => {
  const r = await call('POST', '/auth/signup', { email: `${who}-${tag}@e2e.test`, password: 'noti-pass-1234', name })
  await call('POST', '/auth/onboarded', null, r.cookie)
  cleanup.push(r.body.id)
  return { id: r.body.id, cookie: r.cookie, email: `${who}-${tag}@e2e.test`, name }
}
const linkFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = smtp.inbox.find((x) => x.to.includes(email))
    if (m) return m.link
    await sleep(150)
  }
  throw new Error(`no invite mail for ${email}`)
}
const pushesTo = (sub) => push.received.filter((x) => x.id === sub.id && x.payload)

try {
  const lead = await signup('nlead', '팀장')
  const minji = await signup('nminji', '민지')
  const M = (method, path, body) => call(method, path, body, minji.cookie)

  // 1. Subscribing a browser
  const key = (await M('GET', '/push/key')).body
  check(key.enabled && /^[A-Za-z0-9_-]{80,}$/.test(key.publicKey), 'the server has a VAPID public key')
  const sub = push.subscription()
  check((await M('POST', '/push/subscriptions', { endpoint: sub.endpoint, keys: sub.keys, timezone: tz })).status === 201, 'browser subscription saved')
  check((await M('POST', '/push/subscriptions', { endpoint: 'https://evil.example/push', keys: sub.keys, timezone: tz })).status === 400, 'unknown push services are refused')
  check((await M('POST', '/push/subscriptions', { endpoint: 'http://host.docker.internal:3197/x', keys: sub.keys, timezone: tz })).status === 400, 'other internal addresses are refused')

  // 2. A test notification arrives encrypted for that browser only
  await M('POST', '/push/test')
  const t1 = await push.waitFor((x) => x.id === sub.id && x.payload?.kind === 'test')
  check(t1?.payload.title === '알림이 잘 와요' && t1.payload.url === '/settings', `test push decrypted: ${t1?.payload?.title ?? t1?.error}`)
  check(t1?.headers.authorization?.startsWith('vapid t=') && t1.headers.ttl === '600', 'sent with VAPID and a TTL')
  let list = (await M('GET', '/notifications')).body
  check(list.unread === 1 && list.items[0].kind === 'test' && list.settings.timezone === tz, 'listed unread; time zone taken from the browser')

  // 3. Reminders 10 minutes before a block
  const now = new Date()
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  // The next 10-minute boundary: always within 10 minutes. Close to it, wait it out so the block is not already past.
  const nextSlot = async () => {
    const t = new Date()
    const mins = t.getHours() * 60 + t.getMinutes() + t.getSeconds() / 60
    if (10 - (mins % 10) < 0.5) await sleep((10 - (mins % 10)) * 60000 + 1000)
    const u = new Date()
    return Math.floor((u.getHours() * 60 + u.getMinutes() + u.getSeconds() / 60) / 10) + 1
  }
  if (now.getHours() * 6 + Math.floor(now.getMinutes() / 10) < 138) {
    const settings = list.settings
    await M('PUT', '/notifications/settings', { ...settings, reminders: false })
    let slot = await nextSlot()
    const quiet = (await M('POST', '/blocks', { date, startSlot: slot, endSlot: slot + 1, title: '알림 끈 회의' })).body
    await sleep(4500)
    check(!pushesTo(sub).some((x) => x.payload.kind === 'reminder'), 'reminders off: nothing sent')
    await M('PATCH', `/blocks/${quiet.id}`, { done: true })
    await M('PUT', '/notifications/settings', { ...settings, reminders: true })
    await sleep(4500)
    check(!pushesTo(sub).some((x) => x.payload.kind === 'reminder'), 'a finished block is not reminded')
    await M('DELETE', `/blocks/${quiet.id}`)
    slot = await nextSlot()
    const later = (await M('POST', '/blocks', { date, startSlot: slot + 2, endSlot: slot + 3, title: '나중 회의' })).body
    const block = (await M('POST', '/blocks', { date, startSlot: slot, endSlot: slot + 2, title: '스탠드업' })).body
    const rem = await push.waitFor((x) => x.id === sub.id && x.payload?.kind === 'reminder')
    const hhmm = (s) => `${String(Math.floor(s / 6)).padStart(2, '0')}:${String((s % 6) * 10).padStart(2, '0')}`
    check(/^\d+분 뒤 시작: 스탠드업$/.test(rem?.payload.title ?? '') && rem.payload.body === `${hhmm(slot)}–${hhmm(slot + 2)}` && rem.payload.url === `/day/${date}`, `reminder: ${rem?.payload.title} (${rem?.payload.body})`)
    await sleep(4500)
    check(pushesTo(sub).filter((x) => x.payload.kind === 'reminder').length === 1, 'sent once; the block 20+ minutes away is not yet due')
    await M('DELETE', `/blocks/${block.id}`)
    await M('DELETE', `/blocks/${later.id}`)
  } else {
    console.log('SKIP reminder checks: too close to midnight')
  }

  // 4. Team notifications
  const team = (await call('POST', '/teams', { name: `알림팀 ${tag}` }, lead.cookie)).body
  dropTeam = () => call('DELETE', `/teams/${team.id}`, { confirm: team.name }, lead.cookie)
  await call('POST', `/teams/${team.id}/invites`, { emails: [minji.email], role: 'member' }, lead.cookie)
  await M('POST', `/invites/${(await linkFor(minji.email)).split('/invite/')[1]}/accept`)
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 10)
  const dueISO = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
  const task = (await call('POST', `/teams/${team.id}/tasks`, { title: 'API 문서화', startDate: date, dueDate: dueISO, assignees: [{ userId: minji.id, boxes: 12 }, { userId: lead.id, boxes: 6 }] }, lead.cookie)).body
  const a1 = await push.waitFor((x) => x.id === sub.id && x.payload?.kind === 'assigned')
  check(a1?.payload.title === '‘API 문서화’ 담당자가 됐어요' && a1.payload.body.includes(`알림팀 ${tag}`) && a1.payload.body.includes('팀장 님이 지정') && a1.payload.body.includes('맡은 시간 2시간') && a1.payload.url === `/team/${team.id}`, `assigned: ${a1?.payload.body}`)
  check(!(await call('GET', '/notifications', null, lead.cookie)).body.items.some((n) => n.kind === 'assigned'), 'putting yourself on a task does not notify you')
  await call('PATCH', `/teams/${team.id}/tasks/${task.id}`, { title: 'API 문서화 v2' }, lead.cookie)
  await sleep(800)
  check(pushesTo(sub).filter((x) => x.payload.kind === 'assigned').length === 1, 'editing a task she is already on does not notify again')

  await M('PUT', '/notifications/settings', { reminders: true, team: false, timezone: tz })
  await call('POST', `/teams/${team.id}/tasks`, { title: '조용한 업무', assignees: [{ userId: minji.id, boxes: null }] }, lead.cookie)
  await sleep(1000)
  check(!(await M('GET', '/notifications')).body.items.some((n) => n.title.includes('조용한 업무')), 'team notifications off: none')
  await M('PUT', '/notifications/settings', { reminders: true, team: true, timezone: tz })

  const applied = (await call('POST', `/teams/${team.id}/tasks/${task.id}/breakdown/apply`, { today: date, now: '09:00', userId: minji.id, subtasks: [{ title: '초안', boxes: 12 }], replace: true }, lead.cookie)).body
  const s1 = await push.waitFor((x) => x.id === sub.id && x.payload?.kind === 'split')
  const firstDay = applied.plan.days.find((d) => d.pieces.length).date
  check(s1?.payload.title === '‘API 문서화 v2’ 내 몫이 Brain Dump에 들어갔어요' && s1.payload.body.startsWith('팀장 님이 AI로 세분화') && s1.payload.url === `/day/${firstDay}`, `split: ${s1?.payload.body}`)

  // 5. An expired browser subscription is forgotten
  const gone = push.subscription('gone')
  await M('POST', '/push/subscriptions', { endpoint: gone.endpoint, keys: gone.keys, timezone: tz })
  await M('POST', '/push/test')
  await push.waitFor((x) => x.id === gone.id && x.gone)
  await sleep(500)
  check(psql(`select count(*) from push_subscriptions where endpoint = '${gone.endpoint}'`) === '0', 'a 410 from the push service drops that subscription')

  // 6. The bell
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  watchErrors(p, errors)
  await p.context().addCookies([{ name: 'bs_session', value: minji.cookie, url: BASE }])
  await p.goto(`${BASE}/day/${date}`)
  const unread = (await M('GET', '/notifications')).body.unread
  const bell = p.getByRole('button', { name: `알림 ${unread}개 안 읽음` })
  await bell.waitFor()
  check(unread >= 4, `bell shows ${unread} unread`)
  await bell.click()
  const panel = p.getByRole('dialog', { name: '알림 목록' })
  await panel.getByRole('button', { name: /담당자가 됐어요/ }).click()
  await p.waitForURL(`**/team/${team.id}`)
  await p.getByRole('button', { name: `알림 ${unread - 1}개 안 읽음` }).waitFor()
  await p.waitForTimeout(300)
  check((await M('GET', '/notifications')).body.unread === unread - 1, 'opening one marks it read and goes to its page')
  await p.getByRole('button', { name: /^알림 \d+개 안 읽음$/ }).click()
  await p.getByRole('dialog', { name: '알림 목록' }).getByRole('button', { name: '모두 읽음' }).click()
  await p.getByRole('button', { name: '알림', exact: true }).waitFor()
  check((await M('GET', '/notifications')).body.unread === 0, '모두 읽음 clears the count')
  await p.keyboard.press('Escape')

  // A new one while the page is open (no browser permission): shown in the page
  await M('POST', '/push/test')
  await p.evaluate(() => window.dispatchEvent(new Event('focus')))
  const toast = p.getByRole('status').filter({ hasText: '알림이 잘 와요' })
  await toast.waitFor()
  check(true, 'a new notification shows as a toast in the open page')

  // 7. Settings
  await p.goto(`${BASE}/settings#notifications`)
  const sec = p.getByRole('region', { name: '알림' })
  await sec.getByTestId('push-state').waitFor()
  check((await sec.getByTestId('push-state').textContent()) === '꺼짐' && (await sec.getByRole('button', { name: '이 브라우저에서 알림 받기' }).isVisible()), 'settings: this browser is off, with a button to turn it on')
  await sec.getByLabel(/팀 알림/).uncheck()
  await p.waitForTimeout(500)
  check((await M('GET', '/notifications')).body.settings.team === false, 'settings: team notifications switched off')
  await sec.getByLabel(/팀 알림/).check()
  const sw = await fetch(`${BASE}/sw.js`)
  check(sw.ok && sw.headers.get('cache-control') === 'no-cache' && (await sw.text()).includes("addEventListener('push'"), 'service worker served fresh at /sw.js')

  // 8. Phone header
  const ph = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, signedOut: true })
  watchErrors(ph, errors)
  await ph.context().addCookies([{ name: 'bs_session', value: minji.cookie, url: BASE }])
  await ph.goto(`${BASE}/day/${date}`)
  await ph.getByRole('button', { name: '알림', exact: true }).waitFor()
  check(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: bell fits, no sideways scroll')

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  await dropTeam?.().catch(() => {})
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
  push.server.close()
  smtp.server.close()
}
process.exit(failed() ? 1 : 0)
