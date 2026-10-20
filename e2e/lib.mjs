// Shared helpers for browser tests. Tests only ever talk to the isolated stack.
import { chromium } from 'playwright-core'

export const BASE = process.env.BASE ?? 'http://localhost:3180'
if (!BASE.includes(':3180')) throw new Error(`refusing to run against ${BASE}: tests must use the isolated boxtest stack`)

// Every test runs as the stack's owner account (it can use the fake AI). The stack
// pins SETUP_TOKEN, so the first run claims the owner and later runs log in.
export const OWNER = { email: 'owner@e2e.test', password: 'owner-pass-1234', name: '테스트 소유자' }

/** Calls the API; returns { status, body, cookie } with the session cookie it set, if any. */
export async function call(method, path, body, cookie) {
  const r = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `bs_session=${cookie}` } : {}) },
    body: body && JSON.stringify(body),
  })
  const set = r.headers.getSetCookie?.().find((c) => c.startsWith('bs_session='))
  const text = await r.text()
  return { status: r.status, body: text ? JSON.parse(text) : null, cookie: set ? set.split(';')[0].slice('bs_session='.length) : undefined }
}

let session
async function ownerSession() {
  if (session) return session
  const { body } = await call('GET', '/auth/setup')
  const r = body?.needed
    ? await call('POST', '/auth/setup', { token: 'e2e-setup-token', ...OWNER })
    : await call('POST', '/auth/login', { email: OWNER.email, password: OWNER.password })
  if (!r.cookie) throw new Error(`owner sign-in failed: ${r.status} ${JSON.stringify(r.body)}`)
  return (session = r.cookie)
}

/** Opens Chrome; pages and contexts it makes are signed in as the owner unless { signedOut: true }. */
export async function launch() {
  const cookie = await ownerSession()
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const newContext = browser.newContext.bind(browser)
  browser.newContext = async ({ signedOut, ...opts } = {}) => {
    const ctx = await newContext(opts)
    if (!signedOut) await ctx.addCookies([{ name: 'bs_session', value: cookie, url: BASE }])
    return ctx
  }
  browser.newPage = async (opts) => (await browser.newContext(opts)).newPage()
  return browser
}

/** The owner's API: returns the JSON body (null for 204). */
export const json = async (method, path, body) => (await call(method, path, body, await ownerSession())).body

export function checker() {
  let failed = 0
  const check = (cond, msg) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`)
    if (!cond) failed++
  }
  return { check, failed: () => failed }
}

/** Collects page errors and console errors (ignoring expected 409s). */
export function watchErrors(page, errors) {
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('409') && errors.push(m.text()))
}

/**
 * Stand-in for the browser's continuous speech engine: streams `sentence` word by
 * word (each update repeats everything heard so far) and ends when stopped.
 */
export const fakeSpeech = (sentence) => `
  window.SpeechRecognition = window.webkitSpeechRecognition = class {
    start() {
      const words = ${JSON.stringify(sentence)}.split(' ')
      this.timers = words.map((w, i) => setTimeout(() => {
        this.onresult?.({ resultIndex: 0, results: [{ isFinal: i === words.length - 1, 0: { transcript: words.slice(0, i + 1).join(' ') } }] })
      }, 250 * (i + 1)))
    }
    stop() { this.timers.forEach(clearTimeout); setTimeout(() => this.onend?.(), 0) }
    abort() { this.timers?.forEach(clearTimeout) }
  }`
