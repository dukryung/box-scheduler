// Shared helpers for browser tests. Tests only ever talk to the isolated stack.
import { chromium } from 'playwright-core'

export const BASE = process.env.BASE ?? 'http://localhost:3180'
if (!BASE.includes(':3180')) throw new Error(`refusing to run against ${BASE}: tests must use the isolated boxtest stack`)

export const launch = () =>
  chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })

export const json = (method, path, body) =>
  fetch(`${BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) }).then((r) =>
    r.status === 204 ? null : r.json(),
  )

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
