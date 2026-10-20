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
  return { status: r.status, body: parse(text), cookie: set ? set.split(';')[0].slice('bs_session='.length) : undefined }
}

/** JSON bodies parsed; anything else (e.g. a plain 404) comes back as text. */
function parse(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
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

// ---- the admin console (its own servers on :3190/:8190) ----
import { createHmac } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

export const ADMIN_BASE = process.env.ADMIN_BASE ?? 'http://localhost:3190'
if (!ADMIN_BASE.includes(':3190')) throw new Error(`refusing to run against ${ADMIN_BASE}: tests must use the isolated boxtest stack`)
export const ADMIN = { email: 'e2e-admin@e2e.test', name: '테스트 관리자' }
const STATE = new URL('./.e2e-admin.json', import.meta.url)

/** Runs the admin CLI inside the test stack's admin-api container. */
export function adminCLI(args, input) {
  return execFileSync('docker', ['compose', '-p', 'boxtest', '--env-file', 'test.env', '-f', '../docker-compose.yml', 'exec', '-T', 'admin-api', 'admin', ...args], {
    cwd: new URL('.', import.meta.url),
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

/** RFC 6238 code for a base32 secret. */
export function totp(secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const ch of secret.replace(/=+$/, '')) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0')
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)))
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const h = createHmac('sha1', key).update(msg).digest()
  const off = h[h.length - 1] & 15
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** Calls the admin API; returns { status, body, cookie }. */
export async function adminCall(method, path, body, cookie) {
  const r = await fetch(`${ADMIN_BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `bs_admin=${cookie}` } : {}) },
    body: body && JSON.stringify(body),
  })
  const set = r.headers.getSetCookie?.().find((c) => c.startsWith('bs_admin='))
  const text = await r.text()
  return { status: r.status, body: parse(text), cookie: set ? set.split(';')[0].slice('bs_admin='.length) : undefined }
}

/** Passes a two-factor code, waiting for a fresh 30-second step if this one was already used. */
export async function passTOTP(cookie, secret) {
  for (let i = 0; i < 2; i++) {
    const r = await adminCall('POST', '/auth/totp/verify', { code: totp(secret) }, cookie)
    if (r.status === 200) return r
    await new Promise((res) => setTimeout(res, 31_000 - (Date.now() % 30_000)))
  }
  throw new Error('two-factor code refused twice')
}

let adminState
/** A finished admin sign-in for tests: created with the CLI once, then reused. */
export async function adminSession() {
  if (adminState?.cookie) return adminState
  let st = {}
  try {
    st = JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {}
  if (st.cookie && (await adminCall('GET', '/auth/me', null, st.cookie)).body?.stage === 'ok') return (adminState = st)
  let login = st.password && (await adminCall('POST', '/auth/login', { email: ADMIN.email, password: st.password }))
  if (!login || login.status !== 200 || (login.body.stage !== 'totp' && login.body.stage !== 'ok')) {
    // Unknown or half-set-up: start over from a temporary password.
    const temp = 'e2e-temp-password-1'
    try {
      adminCLI(['create', '--email', ADMIN.email, '--name', ADMIN.name, '--role', 'super', '--password-stdin'], temp + '\n')
    } catch {
      adminCLI(['reset', '--email', ADMIN.email, '--password-stdin'], temp + '\n')
    }
    login = await adminCall('POST', '/auth/login', { email: ADMIN.email, password: temp })
    st = { password: `e2e-admin-${Date.now().toString(36)}-pass` }
    await adminCall('POST', '/auth/password', { current: temp, new: st.password }, login.cookie)
    st.secret = (await adminCall('POST', '/auth/totp/setup', null, login.cookie)).body.secret
  }
  await passTOTP(login.cookie, st.secret)
  st.cookie = login.cookie
  writeFileSync(STATE, JSON.stringify(st))
  return (adminState = st)
}

/** The admin API as the test super admin: returns the JSON body. */
export const admin = async (method, path, body) => (await adminCall(method, path, body, (await adminSession()).cookie)).body

/** Deletes an app account through the admin API (it asks for the admin's password). */
export const removeUser = async (id) => admin('DELETE', `/users/${id}`, { password: (await adminSession()).password })
