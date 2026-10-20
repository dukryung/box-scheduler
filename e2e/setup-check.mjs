// Claims the owner account with Google on a throwaway stack with a fresh database
// (npm run setup-check brings it up and removes it, volumes included).
import { chromium } from 'playwright-core'
import { checker } from './lib.mjs'
import { startFakeGoogle } from './fake-google.mjs'

const BASE = 'http://localhost:3280'
const { check, failed } = checker()
const fake = await startFakeGoogle()
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
const api = (path, init) => fetch(`${BASE}/api${path}`, { headers: { 'Content-Type': 'application/json' }, ...init })

try {
  for (let i = 0; i < 60 && !(await api('/health').then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 1000))
  check((await (await api('/auth/setup')).json()).needed === true, 'fresh stack: owner setup needed')
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  await page.goto(`${BASE}/setup?token=wrong-token`)
  fake.next = { sub: 'owner-sub', email: 'owner@gmail.test', name: '최소유' }
  await page.getByRole('link', { name: 'Google로 소유자 계정 만들기' }).click()
  await page.getByText('설정 링크가 맞지 않아요').waitFor()
  check(true, 'wrong setup token refused')

  await page.goto(`${BASE}/setup?token=setup-check-token`)
  await page.getByRole('link', { name: 'Google로 소유자 계정 만들기' }).click()
  await page.waitForURL('**/day/**')
  const me = await page.evaluate(() => fetch('/api/auth/me').then((r) => r.json()))
  check(me.isOwner && me.email === 'owner@gmail.test' && me.google && me.name === '최소유', 'owner claimed with Google')
  check((await (await api('/auth/setup')).json()).needed === false, 'setup no longer needed')
  const again = await api('/auth/setup', { method: 'POST', body: JSON.stringify({ token: 'setup-check-token', email: 'x@e2e.test', password: 'xxxxxxxx1' }) })
  check(again.status === 409, 'setup cannot be repeated')
} finally {
  await browser.close()
  fake.server.close()
}
process.exit(failed() ? 1 : 0)
