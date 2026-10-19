// Runs every *.test.mjs here in sequence and exits non-zero if any fails.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const files = readdirSync(new URL('.', import.meta.url)).filter((f) => f.endsWith('.test.mjs')).sort()
let failed = 0
for (const f of files) {
  const r = spawnSync('node', [f], { cwd: new URL('.', import.meta.url), encoding: 'utf8' })
  const out = r.stdout + r.stderr
  const pass = (out.match(/^PASS/gm) ?? []).length
  const fail = (out.match(/^FAIL/gm) ?? []).length
  console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${f}: ${pass} pass, ${fail} fail`)
  if (r.status !== 0) {
    failed++
    console.log(out.split('\n').filter((l) => !l.startsWith('PASS')).join('\n'))
  }
}
process.exit(failed ? 1 : 0)
