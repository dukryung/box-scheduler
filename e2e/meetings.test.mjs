// Meetings ("회의"): what was said is pasted in, the AI writes the minutes and
// finds the tasks in the background (a long meeting part by part), and a
// manager gives each task to someone and confirms, which makes team tasks.
// A meeting can also be recorded: the recording is uploaded piece by piece and
// the browser's live captions become the meeting's text. On the Mac mini a
// recording is then written down again by speaker (e2e/fake-stt.mjs here).
import { chromium } from 'playwright-core'
import { BASE, call, checker, launch, OWNER, removeUser, watchErrors } from './lib.mjs'
import { startFakeSMTP } from './fake-smtp.mjs'
import { startFakeSTT } from './fake-stt.mjs'

const { check, failed } = checker()
const errors = []
const smtp = await startFakeSMTP()
const sttFake = await startFakeSTT()
const browser = await launch()
// A browser with a stand-in microphone (a tone) that is allowed without asking.
const micBrowser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
})
// Stand-in for the browser's speech engine in a meeting: each session hears a
// few phrases and then ends on its own (as Chrome's does after a while), so the
// app must start listening again for the next ones.
const meetingSpeech = (sessions) => `
  window.__speechSessions = ${JSON.stringify(sessions)}
  window.SpeechRecognition = window.webkitSpeechRecognition = class {
    start() {
      const phrases = window.__speechSessions.shift() ?? []
      const results = []
      this.timers = phrases.map((p, i) => setTimeout(() => {
        results.push({ isFinal: true, 0: { transcript: p } })
        this.onresult?.({ resultIndex: i, results: [...results, { isFinal: false, 0: { transcript: '…' } }] })
      }, 200 * (i + 1)))
      if (phrases.length) this.timers.push(setTimeout(() => this.onend?.(), 200 * (phrases.length + 1)))
    }
    stop() { this.timers?.forEach(clearTimeout); setTimeout(() => this.onend?.(), 0) }
    abort() { this.timers?.forEach(clearTimeout) }
  }`
const tag = Date.now().toString(36)
const cleanup = []
let dropTeam = null
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = iso(new Date())
const year = today.slice(0, 4)

const signup = async (who, name) => {
  const r = await call('POST', '/auth/signup', { email: `${who}-${tag}@e2e.test`, password: 'meet-pass-1234', name })
  await call('POST', '/auth/onboarded', null, r.cookie)
  cleanup.push(r.body.id)
  return { id: r.body.id, cookie: r.cookie, email: `${who}-${tag}@e2e.test`, name }
}
const linkFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = smtp.inbox.find((x) => x.to.includes(email))
    if (m) return m.link
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error(`no invite mail for ${email}`)
}
const pageAs = async (cookie) => {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, signedOut: true })
  watchErrors(p, errors)
  await p.context().addCookies([{ name: 'bs_session', value: cookie, url: BASE }])
  return p
}

try {
  // The test owner (server AI) leads the team; minji and seojun are members.
  const lead = { cookie: (await call('POST', '/auth/login', { email: OWNER.email, password: OWNER.password })).cookie }
  lead.id = (await call('GET', '/auth/me', null, lead.cookie)).body.id
  await call('POST', '/auth/onboarded', null, lead.cookie)
  const minji = await signup('mminji', '민지')
  const seojun = await signup('mseojun', '서준')
  const team = (await call('POST', '/teams', { name: `회의팀 ${tag}` }, lead.cookie)).body
  dropTeam = () => call('DELETE', `/teams/${team.id}`, { confirm: team.name }, lead.cookie)
  for (const who of [minji, seojun]) {
    await call('POST', `/teams/${team.id}/invites`, { emails: [who.email], role: 'member' }, lead.cookie)
    await call('POST', `/invites/${(await linkFor(who.email)).split('/invite/')[1]}/accept`, null, who.cookie)
  }
  const M = (who, method, path, body) => call(method, `/teams/${team.id}/meetings${path}`, body, who.cookie)
  const settle = async (id) => {
    for (let i = 0; i < 100; i++) {
      const m = (await M(lead, 'GET', `/${id}`)).body
      if (m.status !== 'processing') return m
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('the write-up did not finish')
  }

  // 1. Making a meeting and checking what it was given
  check((await M(minji, 'POST', '', { title: '', heldOn: today })).status === 400, 'a meeting needs a title')
  check((await M(minji, 'POST', '', { title: 'x', heldOn: '5월' })).status === 400, 'and a date')
  const transcript = ['민지: 이번 주는 출시 준비를 봤어요', '서준: 출시일은 다음 달 1일로 결정', '민지: 공지 메일 11/20까지 작성할게요', '서준: 결제 모듈 마무리 할게요', '민지: 다들 수고했어요'].join('\n')
  let r = await M(lead, 'POST', '', { title: '주간 회의', heldOn: today, transcript })
  const weekly = r.body
  check(r.status === 201 && weekly.status === 'draft' && weekly.canEdit && weekly.canConfirm && weekly.minutes === null, 'the lead makes a draft meeting')
  check((await M(seojun, 'GET', '')).body.meetings.some((m) => m.id === weekly.id && m.transcript === undefined), 'everyone in the team sees it in the list (without the text)')
  const empty = (await M(minji, 'POST', '', { title: '빈 회의', heldOn: today })).body
  check(empty.canEdit && !empty.canConfirm, 'a member edits their own meeting but cannot confirm')
  check((await M(minji, 'POST', `/${empty.id}/minutes`)).body.error?.includes('회의 내용'), 'the AI needs something to read')

  // 2. The AI writes the minutes in the background and finds the tasks
  r = await M(lead, 'POST', `/${weekly.id}/minutes`)
  check(r.status === 202 && r.body.status === 'processing' && r.body.aiParts === 1, 'it answers at once while the AI works')
  check((await M(lead, 'PATCH', `/${weekly.id}`, { title: '바꿈' })).status === 409, 'no edits while the AI works')
  let m = await settle(weekly.id)
  check(m.status === 'ready' && m.minutes.summary === '이번 주는 출시 준비를 봤어요' && m.minutes.decisions.length === 1, 'the minutes are written')
  const mail = m.tasks.find((t) => t.title === '공지 메일 작성')
  const pay = m.tasks.find((t) => t.title === '결제 모듈 마무리')
  check(m.tasks.length === 2 && mail && pay, `two tasks found (${m.tasks.map((t) => t.title).join(', ')})`)
  check(mail?.assigneeId === minji.id && mail?.dueDate === `${year}-11-20` && mail?.evidence.includes('11/20까지'), 'a task is given to who said it, with its due date and the words it came from')
  check(pay?.assigneeId === seojun.id && pay?.dueDate === null, "the other speaker's task is theirs, with no due date")
  const notes = (await call('GET', '/notifications', null, lead.cookie)).body
  check(notes.items.some((n) => n.kind === 'meeting' && n.link.includes(weekly.id)), 'whoever asked hears when it is done')

  // 3. A long meeting is read part by part and merged
  const long = Array.from({ length: 80 }, (_, i) => `민지: 안건 ${i + 1}번을 자세히 이야기했고 다음 단계와 일정을 정리해 공유하기로 했어요`).join('\n')
  const big = (await M(lead, 'POST', '', { title: '긴 회의', heldOn: today, transcript: long })).body
  r = await M(lead, 'POST', `/${big.id}/minutes`)
  check(r.body.aiParts >= 3, `a long meeting goes in parts plus a merge (${r.body.aiParts} steps)`)
  m = await settle(big.id)
  check(m.status === 'ready' && m.aiDone === m.aiParts && m.minutes.topics.length === m.aiParts - 1, `the parts' minutes are merged (${m.minutes?.topics.length} parts)`)

  // 4. Who may change and confirm
  check((await M(seojun, 'PATCH', `/${weekly.id}`, { title: '남의 회의' })).status === 403, "a member cannot edit someone else's meeting")
  check((await M(minji, 'POST', `/${empty.id}/confirm`, { tasks: [] })).status === 403, 'a member cannot confirm, even their own')
  check((await M(lead, 'PATCH', `/${weekly.id}`, { tasks: [{ ...pay, assigneeId: 'nobody' }] })).status === 400, 'tasks go only to people in the team')
  r = await M(lead, 'PATCH', `/${weekly.id}`, { tasks: [mail, { ...pay, title: '결제 모듈 마무리와 테스트' }, { title: '회고 일정 잡기', note: '', evidence: '', dueDate: null, assigneeId: '' }] })
  check(r.status === 200 && r.body.tasks.length === 3 && r.body.status === 'ready', 'the lead edits and adds tasks and saves the draft')

  // 5. Confirming makes team tasks and tells the assignees
  const final = r.body.tasks.map((t, i) => (i === 2 ? { ...t, assigneeId: seojun.id } : t))
  r = await M(lead, 'POST', `/${weekly.id}/confirm`, { tasks: final })
  check(r.status === 200 && r.body.status === 'confirmed' && !r.body.canEdit && r.body.tasks.every((t) => t.teamTaskId), 'confirmed: each task points at its team task')
  const teamTasks = (await call('GET', `/teams/${team.id}/tasks`, null, lead.cookie)).body.tasks
  const made = teamTasks.find((t) => t.title === '공지 메일 작성')
  check(teamTasks.length === 3 && made?.assignees[0]?.userId === minji.id && made.dueDate === `${year}-11-20` && made.note.includes('회의: 주간 회의'), 'the team tasks have their assignee, due date and the meeting in the note')
  const told = (await call('GET', '/notifications', null, seojun.cookie)).body.items.filter((n) => n.kind === 'assigned')
  check(told.length === 2, `the assignees are told (${told.length} for 서준)`)
  check((await M(lead, 'PATCH', `/${weekly.id}`, { title: '나중에' })).status === 409 && (await M(lead, 'POST', `/${weekly.id}/confirm`, { tasks: [] })).status === 409, 'a confirmed meeting is closed')
  check((await M(seojun, 'DELETE', `/${weekly.id}`)).status === 403, "a member cannot delete someone else's meeting")

  // 6. In the app: write a meeting, let the AI work, assign and confirm
  const p = await pageAs(lead.cookie)
  await p.goto(`${BASE}/team/${team.id}`)
  await p.getByRole('tab', { name: '회의' }).click()
  await p.getByRole('button', { name: /주간 회의/ }).waitFor()
  check(/확정됨/.test(await p.getByRole('button', { name: /주간 회의/ }).textContent()), 'the list shows each meeting with its state')
  await p.getByRole('button', { name: '새 회의' }).click()
  const form = p.getByRole('form', { name: '새 회의' })
  await form.getByLabel('제목').fill('디자인 회의')
  await form.getByLabel('회의 내용').fill('서준: 시안 검토를 했어요\n민지: 아이콘 정리 할게요')
  await form.getByRole('button', { name: '저장하고 AI로 정리' }).click()
  const view = p.getByRole('region', { name: '디자인 회의' })
  await view.getByRole('region', { name: '회의록' }).waitFor()
  check(p.url().includes('meeting='), 'the new meeting opens on its own page')
  const row = view.getByRole('region', { name: '할 일' }).getByRole('listitem', { name: '아이콘 정리' })
  check((await row.getByLabel('아이콘 정리 담당자').inputValue()) === minji.id, 'the task the AI found is given to who said it')
  await row.getByLabel('아이콘 정리 담당자').selectOption({ label: '서준' })
  await view.getByRole('button', { name: '확정하고 팀 업무 만들기' }).click()
  await view.getByRole('alertdialog').getByRole('button', { name: '확정' }).click()
  await view.getByText('할 일 1개를 팀 업무로 만들었어요').waitFor()
  check((await view.getByText('확정됨').count()) > 0 && (await view.getByRole('button', { name: '저장' }).count()) === 0, 'confirmed in the app: read-only now')
  const icon = (await call('GET', `/teams/${team.id}/tasks`, null, lead.cookie)).body.tasks.find((t) => t.title === '아이콘 정리')
  check(icon?.assignees[0]?.userId === seojun.id, 'the team task went to the person picked')
  await view.getByRole('button', { name: '회의 목록' }).click()
  await p.getByRole('button', { name: /디자인 회의/ }).waitFor()
  check(/확정됨/.test(await p.getByRole('button', { name: /디자인 회의/ }).textContent()), 'back to the list, which shows it confirmed')

  // 7. Recordings arrive in pieces, in order, and play back whole
  const rmeet = (await M(lead, 'POST', '', { title: '녹음 회의', heldOn: today })).body
  const A = (who, method, path, body) => call(method, `/teams/${team.id}/meetings/${rmeet.id}/audio${path}`, body, who.cookie)
  const piece = (who, audioId, seq, text) => fetch(`${BASE}/api/teams/${team.id}/meetings/${rmeet.id}/audio/${audioId}/chunks/${seq}`, {
    method: 'POST', body: text, headers: { Cookie: `bs_session=${who.cookie}`, 'Content-Type': 'application/octet-stream', Origin: BASE },
  })
  check((await A(lead, 'POST', '', { mime: 'video/x-matroska' })).status === 400, 'only audio types are taken')
  check((await A(seojun, 'POST', '', { mime: 'audio/webm' })).status === 403, "a member cannot record someone else's meeting")
  const rec = (await A(lead, 'POST', '', { mime: 'audio/webm;codecs=opus' })).body
  check(rec.id && rec.chunks === 0 && !rec.finished, 'a recording starts empty')
  check((await piece(lead, rec.id, 0, 'AAAA')).status === 200 && (await piece(lead, rec.id, 1, 'BBB')).status === 200, 'pieces are taken in order')
  check((await piece(lead, rec.id, 1, 'BBB')).status === 200, 'a piece sent twice (a retry) is harmless')
  r = await piece(lead, rec.id, 3, 'DD')
  check(r.status === 409 && (await r.json()).expected === 2, 'a piece out of turn is refused, saying which one is due')
  check((await A(lead, 'POST', `/${rec.id}/finish`, { durationSec: 61 })).body.durationSec === 61, 'finishing records the length')
  let got = await fetch(`${BASE}/api/teams/${team.id}/meetings/${rmeet.id}/audio/${rec.id}`, { headers: { Cookie: `bs_session=${seojun.cookie}` } })
  check(got.headers.get('content-type') === 'audio/webm;codecs=opus' && (await got.text()) === 'AAAABBB', 'anyone in the team plays it back: the pieces joined, each once')
  got = await fetch(`${BASE}/api/teams/${team.id}/meetings/${rmeet.id}/audio/${rec.id}`, { headers: { Cookie: `bs_session=${seojun.cookie}`, Range: 'bytes=2-4' } })
  check(got.status === 206 && (await got.text()) === 'AAB', 'and can seek in it')
  check((await piece(lead, rec.id, 2, 'C')).status === 409, 'a finished recording takes no more pieces')
  m = (await M(lead, 'GET', `/${rmeet.id}`)).body
  check(m.audio.length === 1 && m.audio[0].bytes === 7 && m.audio[0].finished, 'the meeting lists its recordings')
  check((await A(seojun, 'DELETE', `/${rec.id}`)).status === 403 && (await A(lead, 'DELETE', `/${rec.id}`)).status === 204, 'only its editors delete a recording')
  check((await M(lead, 'GET', `/${rmeet.id}`)).body.audio.length === 0, 'and it is gone')

  // 9. A recording is transcribed by speaker on the Mac mini; people say who is who
  const recorded = async () => {
    const x = (await A(lead, 'POST', '', { mime: 'audio/webm' })).body
    await piece(lead, x.id, 0, 'RECORDING')
    return x
  }
  const sttDone = async (audioId) => {
    for (let i = 0; i < 60; i++) {
      const a = (await M(lead, 'GET', `/${rmeet.id}`)).body.audio.find((y) => y.id === audioId)
      if (a.sttStatus === 'done' || a.sttStatus === 'failed') return a
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('the transcription did not finish')
  }
  m = (await M(lead, 'GET', `/${rmeet.id}`)).body
  check(m.canTranscribe && !(await M(seojun, 'GET', `/${rmeet.id}`)).body.canTranscribe, 'its editors may transcribe a recording')
  const take1 = await recorded()
  check((await A(lead, 'POST', `/${take1.id}/transcribe`, {})).status === 409, 'a recording still going is not transcribed')
  await A(lead, 'POST', `/${take1.id}/finish`, { durationSec: 8 })
  check((await A(seojun, 'POST', `/${take1.id}/transcribe`, {})).status === 403, "a member cannot transcribe someone else's meeting")
  r = await A(lead, 'POST', `/${take1.id}/transcribe`, { speakers: 2 })
  check(r.status === 202 && r.body.sttStatus === 'queued', 'transcribing starts in the background')
  check((await A(lead, 'POST', `/${take1.id}/transcribe`, {})).status === 409, 'and not twice at once')
  let a1 = await sttDone(take1.id)
  const sent = sttFake.received.at(-1)
  check(sent.bytes === 9 && sent.type === 'audio/webm' && sent.speakers === '2' && sent.language === 'ko' && sent.prompt.includes('민지') && sent.prompt.includes('서준'), 'the whole recording went to the Mac mini, with the team\'s names to spell')
  check(a1.sttStatus === 'done' && a1.segments.length === 3 && a1.segments[1].speaker === 2, 'it comes back as turns of two speakers')
  check((await A(lead, 'PUT', `/${take1.id}/speakers`, { names: { x: '민지' } })).status === 400, 'speakers are numbered')
  a1 = (await A(lead, 'PUT', `/${take1.id}/speakers`, { names: { 1: '민지', 2: '서준' } })).body
  check(a1.speakerNames['1'] === '민지' && a1.speakerNames['2'] === '서준', 'people say who each speaker is')
  m = (await M(lead, 'POST', `/${rmeet.id}/use-transcription`)).body
  check(m.transcript === '민지: 오늘은 출시 일정을 봤어요\n서준: 결제 화면 수정 할게요\n민지: 공지 메일 11/20까지 작성할게요', 'the transcription becomes the meeting\'s text, a line per turn by name')
  await M(lead, 'POST', `/${rmeet.id}/minutes`)
  m = await settle(rmeet.id)
  const byTitle = Object.fromEntries(m.tasks.map((t) => [t.title, t.assigneeId]))
  check(m.tasks.length === 2 && Object.values(byTitle).includes(seojun.id) && Object.values(byTitle).includes(minji.id), 'and the AI gives each task to the speaker who took it')
  const take2 = await recorded()
  await A(lead, 'POST', `/${take2.id}/finish`, { durationSec: 8 })
  await A(lead, 'POST', `/${take2.id}/transcribe`, { speakers: 7, thenMinutes: true })
  check((await M(lead, 'POST', `/${rmeet.id}/minutes`)).status === 409, 'no write-up while a recording is still being transcribed')
  let a2 = await sttDone(take2.id)
  check(a2.sttStatus === 'failed' && a2.sttError.length > 0, 'a failed transcription says so')
  let told2
  for (let i = 0; i < 40 && !told2; i++) {
    told2 = (await call('GET', '/notifications', null, lead.cookie)).body.items.find((n) => n.title.includes('받아쓰지 못했어요'))
    if (!told2) await new Promise((r) => setTimeout(r, 250))
  }
  m = await settle(rmeet.id)
  check(m.status === 'ready' && m.transcript.startsWith('민지: 오늘은') && told2?.body.includes('실시간 자막으로'), 'when it fails, the write-up it was waiting for is made from the text there is')
  r = await A(lead, 'POST', `/${take2.id}/transcribe`, { thenMinutes: true })
  check(r.status === 202 && r.body.sttThenMinutes, 'it can be tried again, this time going on to the minutes')
  await sttDone(take2.id)
  m = await settle(rmeet.id)
  check(m.status === 'ready' && m.transcript.includes('화자 1: 오늘은 출시 일정을 봤어요') && m.transcript.startsWith('민지: '), 'then the text is every transcription (unnamed speakers by number) and the minutes are written')

  // 8. In the app: record a meeting with live captions, then let the AI write it up
  const mic = await micBrowser.newContext({ viewport: { width: 1440, height: 900 } })
  await mic.addCookies([{ name: 'bs_session', value: lead.cookie, url: BASE }])
  await mic.addInitScript(meetingSpeech([['민지: 오늘은 출시 일정을 봤어요', '서준: 결제 화면 수정 할게요'], ['민지: 공지 메일 11/20까지 작성할게요']]))
  const mp = await mic.newPage()
  watchErrors(mp, errors)
  await mp.goto(`${BASE}/team/${team.id}?tab=meetings`)
  await mp.getByRole('button', { name: '새 회의' }).click()
  await mp.getByRole('form', { name: '새 회의' }).getByRole('button', { name: '녹음하며 시작' }).click()
  const live = mp.getByRole('status', { name: '녹음 중' })
  await live.waitFor()
  await live.getByText('공지 메일 11/20까지 작성할게요').waitFor()
  check((await live.getByLabel('실시간 자막').textContent()).includes('결제 화면 수정 할게요'), 'captions show as people talk, and go on after the speech engine stops by itself')
  check(!mp.url().includes('record=1') && (await mp.getByRole('button', { name: '회의 목록' }).isDisabled()), 'recording started with the new meeting; leaving is held until it ends')
  await mp.waitForTimeout(1500)
  await live.getByRole('button', { name: '회의 녹음 종료' }).click()
  const recView = mp.getByRole('region', { name: /회의$/ })
  await recView.getByRole('status', { name: '회의 정리 단계' }).getByText(/텍스트로 받아쓰고/).waitFor()
  check(await recView.getByRole('button', { name: 'AI로 회의록 정리' }).isDisabled(), 'ending the recording turns it into text first; the write-up waits for that')
  await recView.getByRole('region', { name: '회의록' }).waitFor()
  check((await recView.getByRole('region', { name: '할 일' }).getByRole('listitem').count()) === 2, 'then the AI suggests the minutes and two tasks')
  check((await recView.getByText('AI가 제안한 회의록과 할 일이에요').count()) === 1, 'for the lead to look over, fix and assign')
  check(
    (await recView.getByRole('region', { name: '할 일' }).getByRole('combobox', { name: /담당자/ }).evaluateAll((s) => s.map((x) => x.value))).every((v) => v === ''),
    'nobody is assigned when the speakers are not known yet',
  )
  const recId = new URL(mp.url()).searchParams.get('meeting')
  m = (await M(lead, 'GET', `/${recId}`)).body
  check(m.transcript.split('\n').length === 3 && m.transcript.startsWith('화자 1: 오늘은 출시 일정을 봤어요'), 'the recording was transcribed by speaker and became the text')
  check(m.audio[0]?.sttStatus === 'done', 'its transcription is kept with the recording')
  check(m.audio.length === 1 && m.audio[0].finished && m.audio[0].bytes > 1000 && m.audio[0].durationSec >= 2, `the recording was saved (${m.audio[0]?.bytes} bytes, ${m.audio[0]?.durationSec}s)`)
  await recView.getByRole('listitem', { name: '녹음 1' }).getByRole('button', { name: '듣기' }).click()
  const player = recView.locator('audio')
  await player.waitFor()
  const playable = await player.evaluate((el) => new Promise((done) => (el.readyState >= 1 ? done(true) : ((el.onloadedmetadata = () => done(true)), (el.onerror = () => done(false))))))
  check(playable, 'the recording plays in the page')
  const said = recView.getByRole('listitem', { name: '녹음 1' }).getByLabel('받아쓰기')
  await said.getByRole('button', { name: /받아쓰기 · 화자 2명/ }).click()
  await said.getByLabel('화자 2 이름').selectOption('서준')
  await said.locator('p', { hasText: /서준\s*결제 화면 수정 할게요/ }).waitFor()
  await said.getByRole('button', { name: '회의 내용으로 쓰기' }).click()
  await said.getByRole('button', { name: '바꾸기' }).click()
  await recView.getByText('받아쓰기를 회의 내용에 넣었어요').waitFor()
  check((await recView.getByRole('textbox', { name: '회의 내용' }).inputValue()).includes('서준: 결제 화면 수정 할게요'), 'in the app, naming a speaker and using the transcription puts their name in the text')
  await mic.close()

  // A member sees a meeting read-only
  const sp = await pageAs(seojun.cookie)
  await sp.goto(`${BASE}/team/${team.id}?tab=meetings&meeting=${big.id}`)
  await sp.getByRole('region', { name: '회의록' }).waitFor()
  check((await sp.getByRole('button', { name: /AI로/ }).count()) === 0 && (await sp.getByRole('button', { name: '확정하고 팀 업무 만들기' }).count()) === 0, "a member reads someone else's meeting but cannot change it")

  check(errors.length === 0, `no console errors ${errors.join(' | ')}`)
} finally {
  await dropTeam?.().catch(() => {})
  for (const id of cleanup) await removeUser(id).catch(() => {})
  await browser.close()
  await micBrowser.close()
  smtp.server.close()
  sttFake.server.close()
}
process.exit(failed() ? 1 : 0)
