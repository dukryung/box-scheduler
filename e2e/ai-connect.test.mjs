// AI for every account: the service's own local LLM (set up in the admin console)
// with a daily limit and a queue, plus an optional personal Anthropic key.
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { ADMIN_BASE, BASE, adminCLI, adminCall, adminSession, call, checker, json, launch, removeUser, watchErrors } from './lib.mjs'
import { GOOD_KEY, startFakeAI } from './fake-ai.mjs'

const { check, failed } = checker()
const errors = []
const fake = await startFakeAI()
const browser = await launch()
const sup = await adminSession()
const tag = Date.now().toString(36)
const cleanup = []
const LOCAL = 'http://host.docker.internal:3198'
const psql = (sql) =>
  execFileSync('docker', ['compose', '-p', 'boxtest', '--env-file', 'test.env', '-f', '../docker-compose.yml', 'exec', '-T', 'db', 'psql', '-U', 'boxscheduler', '-d', 'boxscheduler', '-tAc', sql], {
    cwd: new URL('.', import.meta.url),
    encoding: 'utf8',
  }).trim()
const saveService = (cfg) =>
  adminCall('PUT', '/service-ai', { enabled: true, baseUrl: LOCAL, planModel: 'qwen3:8b', requestModel: 'qwen3:8b', tidyModel: 'llama3.2:3b', concurrency: 1, dailyLimit: 5, password: sup.password, ...cfg }, sup.cookie)

try {
  await saveService({ enabled: false })

  // 1. Service AI off and no key: AI features say so
  const u = await call('POST', '/auth/signup', { email: `ai-${tag}@e2e.test`, password: 'ai-pass-1234', name: '에이아이' })
  cleanup.push(u.body.id)
  const as = (method, path, body) => call(method, path, body, u.cookie)
  check((await as('POST', '/assistant/tidy', { text: '음 회의 완료' })).body.code === 'ai_not_connected', 'no AI yet: refused with ai_not_connected')

  // 2. Admins set up the service AI; it is checked before saving
  let r = await saveService({ baseUrl: 'http://host.docker.internal:3999' })
  check(r.status === 400 && r.body.error.includes('연결하지 못했어요'), `unreachable server not saved (${r.body.error})`)
  r = await saveService({ tidyModel: 'nope:1b' })
  check(r.status === 400 && r.body.error.includes('nope:1b'), 'missing model not saved')
  r = await saveService({ password: 'not-the-password' })
  check(r.status === 403, 'saving asks for the admin password again')
  r = await saveService({ apiKey: 'local-secret-key-9999' })
  check(r.status === 200 && r.body.config.enabled && r.body.config.keyHint === '…9999', 'service AI saved and on (key shown as …9999)')
  check(!psql(`select encode(key_sealed, 'escape') from service_ai`).includes('local-secret'), 'service key stored sealed')
  check(fake.calls.some((c) => c.who === 'local-done' && c.auth === 'Bearer local-secret-key-9999'), 'the key is sent to the AI server')
  const op = { email: `svcop-${tag}@e2e.test` }
  adminCLI(['create', '--email', op.email, '--role', 'operator', '--password-stdin'], 'svc-op-temp-pass-1\n')
  // (an operator would see the page but cannot save: covered by role checks on /service-ai PUT)
  const audit = (await adminCall('GET', '/audit?action=service-ai', null, sup.cookie)).body
  check(audit.entries[0]?.detail.includes('llama3.2:3b'), 'the change is in the audit log')

  // 3. Every account uses it by default
  let st = (await as('GET', '/ai')).body
  check(st.settings.tidy === 'service' && st.service.enabled && st.service.dailyLimit === 5 && st.service.models.tidy === 'llama3.2:3b', 'default AI is the service AI')
  const t1 = await as('POST', '/assistant/tidy', { text: '음 회의 완료' })
  check(t1.status === 200 && t1.body.text === '[local] 회의 완료', `tidy answered by the service AI (${t1.body.text})`)
  const today = new Date().toISOString().slice(0, 10)
  const q1 = await as('POST', '/assistant/preview', { message: '회의 완료', viewDate: today, today, now: '10:00', history: [] })
  check(q1.status === 200 && q1.body.reply === 'local 응답', 'requests use the qwen3 model (its thinking stripped)')

  // 4. The settings page shows it and today's use
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  watchErrors(page, errors)
  await page.context().addCookies([{ name: 'bs_session', value: u.cookie, url: BASE }])
  await page.goto(`${BASE}/settings`)
  await page.getByText('서비스 AI를 바로 쓸 수 있어요').waitFor()
  check((await page.getByTestId('service-used').textContent()) === '2', 'settings: today 2 / 5 used')
  check(await page.getByLabel('음성 정리에 쓸 AI').locator('option', { hasText: '서비스 AI · llama3.2:3b' }).count() === 1, 'feature picker offers the service AI')
  check((await page.getByRole('form', { name: 'AI 연결 추가' }).count()) === 0, 'no connection form forced open')

  // 5. The daily limit
  for (let i = 0; i < 3; i++) await as('POST', '/assistant/tidy', { text: '회의 완료' })
  const over = await as('POST', '/assistant/tidy', { text: '회의 완료' })
  check(over.status === 429 && over.body.code === 'ai_limit' && over.body.error.includes('5회'), 'sixth call today refused: ai_limit')
  check((await json('POST', '/assistant/tidy', { text: '음 회의 완료' })).text === '회의 완료', 'the owner is not limited (server subscription)')

  // 6. A personal Anthropic key keeps them going
  await page.reload()
  await page.getByRole('button', { name: '+ 내 API 키 연결' }).click()
  const form = page.getByRole('form', { name: 'AI 연결 추가' })
  await form.getByLabel('API 키').fill(GOOD_KEY)
  await form.getByRole('button', { name: '확인하고 연결하기' }).click()
  await page.getByRole('listitem', { name: 'Anthropic API' }).waitFor()
  const t2 = await as('POST', '/assistant/tidy', { text: '음 회의 완료' })
  check(t2.status === 200 && t2.body.text.startsWith('[anthropic]'), 'with their own key, past the service limit')
  check((await as('POST', '/ai/connections', { kind: 'openai', baseUrl: LOCAL, model: 'qwen3:8b' })).status === 400, 'personal local LLM connections are no longer offered')
  check((await as('PUT', '/ai/settings', { plan: 'server', request: '', tidy: '' })).status === 400, "cannot pick the owner's server subscription")
  await page.close()

  // 7. The queue: one at a time on the service AI, others wait
  await saveService({ tidyModel: 'slow:1b', dailyLimit: 0 })
  const v = await call('POST', '/auth/signup', { email: `ai3-${tag}@e2e.test`, password: 'ai-pass-1234' })
  cleanup.push(v.body.id)
  const start = Date.now()
  const runs = [0, 1, 2].map(() => call('POST', '/assistant/tidy', { text: '회의 완료' }, v.cookie))
  await new Promise((res) => setTimeout(res, 700))
  const queue = (await call('GET', '/ai/queue', null, v.cookie)).body
  const results = await Promise.all(runs)
  const took = Date.now() - start
  check(queue.running === 1 && queue.waiting === 2, `queue while busy: running ${queue.running}, waiting ${queue.waiting}`)
  check(results.every((x) => x.status === 200) && took >= 5500, `three 2-second calls ran one after another (${took}ms)`)
  const waited = Number(psql(`select max(waited_ms) from ai_calls where user_id = '${v.body.id}'`))
  check(waited >= 3500, `the last call waited its turn (${waited}ms, logged)`)

  // 8. The console page
  const ctx = await (await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })).newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addCookies([{ name: 'bs_admin', value: sup.cookie, url: ADMIN_BASE }])
  const ap = await ctx.newPage()
  watchErrors(ap, errors)
  await ap.goto(`${ADMIN_BASE}/service-ai`)
  await ap.getByRole('heading', { name: '서비스 AI' }).waitFor()
  check(await ap.getByText('켜짐', { exact: true }).isVisible(), 'console: service AI shown as on')
  check((await ap.getByText('24시간 호출').locator('..').textContent()).match(/\d+/)?.[0] >= 9, 'console: 24h call count')
  await ap.getByRole('button', { name: '지금 연결 확인' }).click()
  await ap.getByText('잘 연결돼요.').waitFor()
  check(true, 'console: connection check from the page')
  await ap.getByRole('button', { name: '모델 불러오기' }).click()
  await ap.getByLabel('음성 정리 모델').locator('option', { hasText: 'qwen3:8b' }).waitFor({ state: 'attached' })
  check(true, 'console: models loaded from the AI server')
  await ap.getByLabel('음성 정리 모델').selectOption('llama3.2:3b')
  await ap.getByRole('button', { name: '연결 확인하고 저장' }).click()
  await ap.getByRole('dialog', { name: '서비스 AI 저장' }).getByLabel('내 관리자 비밀번호').fill(sup.password)
  await ap.getByRole('dialog', { name: '서비스 AI 저장' }).getByRole('button', { name: '저장' }).click()
  await ap.getByText('저장했어요.').waitFor()
  check((await adminCall('GET', '/service-ai', null, sup.cookie)).body.config.tidyModel === 'llama3.2:3b', 'console: saved from the form')
  await ctx.browser().close()

  // 9. Operators may look but not change it; turning it off stops it
  const opLogin = await adminCall('POST', '/auth/login', { email: op.email, password: 'svc-op-temp-pass-1' })
  check(opLogin.body.stage === 'password' && (await adminCall('PUT', '/service-ai', { enabled: false, password: 'x' }, opLogin.cookie)).status === 403, 'operator cannot change the service AI')
  await saveService({ enabled: false })
  check((await call('POST', '/assistant/tidy', { text: '회의 완료' }, v.cookie)).body.code === 'ai_not_connected', 'service AI off: accounts without a key are told to connect one')

  check(errors.filter((e) => !/40[03]|429/.test(e)).length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  await saveService({ enabled: false }).catch(() => {})
  for (const id of cleanup) await removeUser(id).catch(() => {})
  try {
    adminCLI(['disable', '--email', `svcop-${tag}@e2e.test`])
  } catch {}
  await browser.close()
  fake.server.close()
}
process.exit(failed() ? 1 : 0)
