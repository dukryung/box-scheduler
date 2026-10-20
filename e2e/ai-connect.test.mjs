// Accounts' own AI: an Anthropic key or a local LLM, chosen per feature, with
// keys kept sealed and internal addresses refused.
import { execFileSync } from 'node:child_process'
import { BASE, call, checker, json, launch, removeUser, watchErrors } from './lib.mjs'
import { GOOD_KEY, startFakeAI } from './fake-ai.mjs'

const { check, failed } = checker()
const errors = []
const fake = await startFakeAI()
const browser = await launch()
const tag = Date.now().toString(36)
const cleanup = []
const LOCAL = 'http://host.docker.internal:3198'

try {
  const u = await call('POST', '/auth/signup', { email: `ai-${tag}@e2e.test`, password: 'ai-pass-1234', name: '에이아이' })
  cleanup.push(u.body.id)
  const as = (method, path, body) => call(method, path, body, u.cookie)

  // 1. No AI yet: the features say so
  let st = (await as('GET', '/ai')).body
  check(st.connections.length === 0 && st.settings.tidy === '' && !st.serverAvailable && st.keysEnabled, 'new account: no AI, no server subscription')
  const blocked = await as('POST', '/assistant/tidy', { text: '음 회의 완료' })
  check(blocked.status === 403 && blocked.body.code === 'ai_not_connected', 'AI feature refused until connected')

  // 2. Browser: add an Anthropic key in 설정 (a wrong key first)
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  watchErrors(page, errors)
  await page.context().addCookies([{ name: 'bs_session', value: u.cookie, url: BASE }])
  await page.goto(`${BASE}/settings`)
  const form = page.getByRole('form', { name: 'AI 연결 추가' })
  await form.waitFor()
  check(true, 'settings opens the add form when there is no AI')
  await form.getByLabel('API 키').fill('sk-ant-wrong-key-1111')
  await form.getByRole('button', { name: '확인하고 연결하기' }).click()
  await form.getByRole('alert').waitFor()
  check((await form.getByRole('alert').textContent()).includes('API 키가 맞지 않아요'), 'wrong key: checked before saving, nothing saved')
  check((await as('GET', '/ai')).body.connections.length === 0, 'no connection saved for a wrong key')
  await form.getByLabel('API 키').fill(GOOD_KEY)
  await form.getByLabel('모델').selectOption('claude-haiku-5-5')
  await form.getByRole('button', { name: '확인하고 연결하기' }).click()
  const row = page.getByRole('listitem', { name: 'Anthropic API' })
  await row.waitFor()
  check((await row.textContent()).includes('키 …0042') && (await row.textContent()).includes('claude-haiku-5-5'), 'connection listed with model and only the last 4 key characters')
  st = (await as('GET', '/ai')).body
  const anth = st.connections[0]
  check(['plan', 'request', 'tidy'].every((f) => st.settings[f] === anth.id), 'first connection is used for every feature')
  check(!JSON.stringify(st).includes(GOOD_KEY), 'the key never comes back from the API')
  const sealed = execFileSync('docker', ['compose', '-p', 'boxtest', '--env-file', 'test.env', '-f', '../docker-compose.yml', 'exec', '-T', 'db', 'psql', '-U', 'boxscheduler', '-d', 'boxscheduler', '-tAc', `select encode(key_sealed, 'escape') from ai_connections where id = '${anth.id}'`], { cwd: new URL('.', import.meta.url), encoding: 'utf8' })
  check(sealed.length > 20 && !sealed.includes('sk-ant'), 'the key is stored sealed, not as text')

  // 3. Features use the account's own AI
  const t1 = await as('POST', '/assistant/tidy', { text: '음 회의 완료' })
  check(t1.status === 200 && t1.body.text.startsWith('[anthropic]'), `tidy answered by the Anthropic key (${t1.body.text})`)

  // 4. Add the local LLM: load its models, pick one
  await page.getByRole('button', { name: '+ AI 연결 추가' }).click()
  await form.getByRole('radio', { name: /로컬 LLM/ }).click()
  await form.getByLabel('서버 주소').fill(LOCAL)
  await form.getByRole('button', { name: '모델 불러오기' }).click()
  await form.getByLabel('모델').locator('option', { hasText: 'llama3.2:3b' }).waitFor({ state: 'attached' })
  check((await form.getByLabel('모델').locator('option').allTextContents()).join() === 'qwen3:14b,llama3.2:3b', 'models listed from the local server')
  await form.getByLabel('모델').selectOption('llama3.2:3b')
  await form.getByLabel('이름 (선택)').fill('집 Mac mini')
  await form.getByRole('button', { name: '확인하고 연결하기' }).click()
  await page.getByRole('listitem', { name: '집 Mac mini' }).waitFor()
  check(true, 'local LLM connected after a check')

  // 5. Choose per feature: tidy on the local model, requests stay on Anthropic
  const local = (await as('GET', '/ai')).body.connections.find((c) => c.kind === 'openai')
  await page.getByLabel('음성 정리에 쓸 AI').selectOption(local.id)
  await page.getByText('저장했어요.').waitFor()
  const t2 = await as('POST', '/assistant/tidy', { text: '음 회의 완료' })
  check(t2.body.text?.startsWith('[local]'), `tidy now on the local model (${t2.body.text})`)
  const today = new Date().toISOString().slice(0, 10)
  const req = await as('POST', '/assistant/preview', { message: '회의 완료', viewDate: today, today, now: '10:00', history: [] })
  check(req.status === 200 && req.body.reply === 'anthropic 응답', 'requests still on Anthropic')
  check(!(await page.getByLabel('음성 정리에 쓸 AI').locator('option', { hasText: '서버 Claude 구독' }).count()), "a normal account cannot pick the server's subscription")
  await page.close()

  // 6. Internal addresses are refused
  for (const base of ['http://169.254.169.254', 'http://db:5432', 'http://localhost:8080', 'http://10.0.0.1:11434']) {
    const r = await as('POST', '/ai/connections', { kind: 'openai', baseUrl: base, model: 'x' })
    check(r.status === 400 && /안쪽 주소|연결하지 못했어요/.test(r.body.error), `refused: ${base} (${r.body.error})`)
  }
  check((await as('POST', '/ai/models', { baseUrl: 'http://169.254.169.254/latest/meta-data' })).status === 400, 'model listing refuses internal addresses too')
  check((await as('POST', '/ai/connections', { kind: 'openai', baseUrl: 'file:///etc/passwd', model: 'x' })).status === 400, 'non-http addresses refused')

  // 7. Other accounts cannot touch these connections
  const other = await call('POST', '/auth/signup', { email: `ai2-${tag}@e2e.test`, password: 'ai-pass-1234' })
  cleanup.push(other.body.id)
  check((await call('POST', `/ai/connections/${anth.id}/test`, null, other.cookie)).status === 404, "another account cannot test someone's connection")
  check((await call('DELETE', `/ai/connections/${anth.id}`, null, other.cookie)).status === 404, "…or delete it")
  check((await call('PUT', '/ai/settings', { plan: anth.id, request: '', tidy: '' }, other.cookie)).status === 400, '…or pick it for their own features')
  check((await call('PUT', '/ai/settings', { plan: 'server', request: '', tidy: '' }, other.cookie)).status === 400, "…or pick the owner's server subscription")

  // 8. Deleting a connection turns its features off
  check((await as('DELETE', `/ai/connections/${local.id}`)).status === 204, 'local connection deleted')
  st = (await as('GET', '/ai')).body
  check(st.settings.tidy === '' && st.settings.plan === anth.id, 'its feature falls back to none; others keep theirs')
  check((await as('POST', '/assistant/tidy', { text: '음 회의 완료' })).body.code === 'ai_not_connected', 'tidy off again')

  // 9. The owner still has the server subscription by default
  const ownerAI = await json('GET', '/ai')
  check(ownerAI.serverAvailable && ownerAI.settings.tidy === 'server', 'owner: server subscription available and used by default')
  check((await json('POST', '/assistant/tidy', { text: '음 회의 완료' })).text === '회의 완료', "owner's tidy still uses the server's AI")

  // 10. Checking a saved connection again
  const r = await as('POST', `/ai/connections/${anth.id}/test`)
  check(r.body.ok === true, 'connection check passes')
  // The wrong key's 400 is staged; anything else counts.
  check(errors.filter((e) => !e.includes('400')).length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
  fake.server.close()
}
process.exit(failed() ? 1 : 0)
