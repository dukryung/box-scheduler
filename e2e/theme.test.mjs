// Light / dark / system: the top-bar switch cycles, applies at once, and survives a reload; the logo goes home.
import { checker, launch, BASE, watchErrors } from './lib.mjs'

const { check, failed } = checker()
const errors = []
const browser = await launch()

try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
  const page = await ctx.newPage()
  watchErrors(page, errors)
  await page.goto(`${BASE}/stats`)
  const theme = () => page.evaluate(() => document.documentElement.dataset.theme)
  const ground = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
  const toggle = page.getByRole('button', { name: /화면 모드/ })

  check((await theme()) === 'dark', 'system mode follows the OS (dark)')
  check((await ground()) === 'rgb(18, 16, 14)', 'dark ground applied')
  check((await toggle.getAttribute('aria-label')).includes('시스템 설정'), 'starts on 시스템 설정')

  await toggle.click()
  check((await theme()) === 'light' && (await ground()) === 'rgb(252, 250, 247)', '→ 라이트 even though the OS is dark')
  await page.reload()
  check((await theme()) === 'light', '라이트 kept after reload')

  await toggle.click()
  check((await theme()) === 'dark', '→ 다크')
  await page.emulateMedia({ colorScheme: 'light' })
  check((await theme()) === 'dark', '다크 ignores the OS switching to light')

  await toggle.click()
  check((await theme()) === 'light', '→ 시스템 follows the OS again (now light)')
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(100)
  check((await theme()) === 'dark', 'system mode tracks OS changes live')
  check((await page.locator('meta[name=theme-color]').getAttribute('content')) === '#1C1A18', 'browser bar color follows')

  // The header logo goes home: today's timetable.
  await page.getByRole('link', { name: /Box Scheduler 홈/ }).click()
  await page.waitForURL('**/day/**')
  const d = new Date()
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  check(page.url().endsWith(`/day/${today}`), `logo → today (${page.url()})`)

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await phone.goto(`${BASE}/tasks`)
  check(await phone.getByRole('button', { name: /화면 모드/ }).isVisible(), 'phone: switch on the 보관함 screen')
  await phone.close()

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  await browser.close()
}
process.exit(failed() ? 1 : 0)
