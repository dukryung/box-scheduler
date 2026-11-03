// Stand-in for the Mac mini's transcription service (stt/server.py): a job is
// queued, runs for a moment and comes back with two speakers. Asking for 7
// speakers makes the job fail, for tests of that.
import { createServer } from 'node:http'

export const SEGMENTS = [
  { start: 0, end: 2.5, speaker: 1, text: '오늘은 출시 일정을 봤어요' },
  { start: 3, end: 5, speaker: 2, text: '결제 화면 수정 할게요' },
  { start: 5.5, end: 8, speaker: 1, text: '공지 메일 11/20까지 작성할게요' },
]

export function startFakeSTT(port = 3195) {
  const fake = { jobs: new Map(), received: [], server: null }
  let n = 0
  fake.server = createServer(async (req, res) => {
    const json = (status, v) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    const url = new URL(req.url, 'http://x')
    if (req.method === 'POST' && url.pathname === '/v1/jobs') {
      let bytes = 0
      for await (const c of req) bytes += c.length
      const id = `job${++n}`
      const q = Object.fromEntries(url.searchParams)
      fake.received.push({ id, bytes, type: req.headers['content-type'], ...q })
      const job = { id, status: 'queued', stage: null, error: null, duration: 8, created: Date.now(), fail: q.speakers === '7' }
      fake.jobs.set(id, job)
      setTimeout(() => Object.assign(job, { status: 'running', stage: 'transcribe' }), 300)
      setTimeout(() => {
        if (job.fail) Object.assign(job, { status: 'failed', stage: null, error: 'fake failure' })
        else Object.assign(job, { status: 'done', stage: null, result: { language: 'ko', speakers: 2, segments: SEGMENTS } })
      }, 1200)
      return json(202, { ...job, position: 1 })
    }
    const job = fake.jobs.get(url.pathname.split('/')[3])
    if (url.pathname.startsWith('/v1/jobs/') && job) {
      if (req.method === 'DELETE') return fake.jobs.delete(job.id), json(200, { ok: true })
      return json(200, job)
    }
    if (url.pathname === '/health') return json(200, { ok: true })
    json(404, { error: 'no such job' })
  })
  return new Promise((resolve) => fake.server.listen(port, () => resolve(fake)))
}
