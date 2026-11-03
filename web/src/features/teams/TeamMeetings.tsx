import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { teamApi } from '../../api/client'
import type { Meeting, MeetingStatus, MeetingTask, Minutes, TeamDetail } from '../../api/types'
import { AIError } from '../../components/AIError'
import { ConfirmInline } from '../../components/ConfirmInline'
import { ChevronLeft, Close, Mic, Plus, Sparkle } from '../../components/icons'
import { aiButton, aiOutlineButton, card, primaryButton, secondaryButton } from '../../components/styles'
import { WEEKDAYS, parseISODate, todayISO } from '../../lib/date'
import { captionsSupported, recordingSupported, useMeetingRecorder } from '../../lib/useMeetingRecorder'

const field = 'h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent disabled:opacity-60 md:text-sm'
const area = 'w-full rounded-[10px] border border-line-strong bg-surface px-3.5 py-2.5 text-[15px] leading-relaxed text-ink outline-none focus:border-accent disabled:opacity-60 md:text-sm'
const small = 'h-9 rounded-md border border-line-strong bg-surface px-2 text-sm text-ink outline-none focus:border-accent'
const MAX_TRANSCRIPT = 100000

const STATUS_LABEL: Record<MeetingStatus, string> = { draft: '작성 중', processing: 'AI 정리 중', ready: '확인 필요', confirmed: '확정됨' }
const STATUS_TONE: Record<MeetingStatus, string> = {
  draft: 'bg-subtle text-ink-2',
  processing: 'bg-ai-soft text-ai-ink',
  ready: 'bg-accent-soft text-accent-ink',
  confirmed: 'bg-good/10 text-good',
}

const dayText = (iso: string) => {
  const d = parseISODate(iso)
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`
}
const clock = (sec: number) => {
  const h = Math.floor(sec / 3600)
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const ss = String(sec % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
const fileSize = (n: number) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)}MB`)
/** The text so far with what was heard added on new lines. */
const withCaptions = (base: string, heard: string[]) => [base.trim(), ...heard].filter(Boolean).join('\n')
const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)

function StatusPill({ m }: { m: Meeting }) {
  const progress = m.status === 'processing' && m.aiParts > 1 ? ` ${m.aiDone}/${m.aiParts}` : ''
  return (
    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE[m.status]}`}>
      {STATUS_LABEL[m.status]}
      {progress}
    </span>
  )
}

/** A team's meetings: paste what was said, let the AI write the minutes and find the tasks, then confirm. */
export function TeamMeetings({ team }: { team: TeamDetail }) {
  const [params, setParams] = useSearchParams()
  const open = params.get('meeting')
  const record = params.get('record') === '1'
  const show = (id: string | null, rec = false) => setParams(id ? { tab: 'meetings', meeting: id, ...(rec ? { record: '1' } : {}) } : { tab: 'meetings' }, { replace: !id })
  if (open)
    return <MeetingView key={open} team={team} id={open} autoRecord={record} onRecordStarted={() => setParams({ tab: 'meetings', meeting: open }, { replace: true })} onBack={() => show(null)} />
  return <MeetingList team={team} onOpen={show} />
}

function MeetingList({ team, onOpen }: { team: TeamDetail; onOpen: (id: string, record?: boolean) => void }) {
  const [meetings, setMeetings] = useState<Meeting[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      setMeetings((await teamApi.meetings(team.id)).meetings)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [team.id])
  useEffect(() => {
    void load()
  }, [load])
  // Write-ups run on the server; keep the list current while one is running.
  const running = meetings?.some((m) => m.status === 'processing')
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [running, load])

  return (
    <section aria-label="회의" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted">회의 내용을 붙여 넣으면 AI가 회의록과 할 일을 정리해요. 매니저가 담당자를 정해 확정하면 팀 업무가 돼요.</p>
        {!adding && (
          <button className={`${primaryButton} h-10 shrink-0`} onClick={() => setAdding(true)}>
            <Plus size={16} /> 새 회의
          </button>
        )}
      </div>
      {adding && <NewMeeting team={team} onCancel={() => setAdding(false)} onCreated={(m, record) => onOpen(m.id, record)} />}
      {error && <p className="text-sm text-danger">{error}</p>}
      {meetings && meetings.length === 0 && !adding && <p className={`${card} px-4 py-8 text-center text-sm text-muted`}>아직 회의가 없어요. 새 회의를 만들어 보세요.</p>}
      <ul className="flex flex-col gap-2">
        {meetings?.map((m) => (
          <li key={m.id}>
            <button onClick={() => onOpen(m.id)} className={`${card} flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-subtle`}>
              <span className="w-[72px] shrink-0 font-mono text-xs text-muted">{dayText(m.heldOn)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">{m.title}</span>
                <span className="block truncate text-xs text-muted">
                  {m.createdByName || '알 수 없음'}
                  {m.taskCount > 0 && ` · 할 일 ${m.taskCount}개`}
                  {m.minutes?.summary && ` · ${m.minutes.summary}`}
                </span>
              </span>
              <StatusPill m={m} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function NewMeeting({ team, onCancel, onCreated }: { team: TeamDetail; onCancel: () => void; onCreated: (m: Meeting, record: boolean) => void }) {
  const [title, setTitle] = useState('')
  const [heldOn, setHeldOn] = useState(todayISO())
  const [transcript, setTranscript] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async (summarize: boolean, record = false) => {
    // Recording right away: a title can come later.
    const name = title.trim() || (record ? `${dayText(heldOn)} 회의` : '')
    if (!name) return setError('회의 제목을 적어 주세요')
    setSaving(true)
    setError(null)
    try {
      const m = await teamApi.createMeeting(team.id, { title: name, heldOn, transcript })
      if (summarize && transcript.trim()) {
        try {
          await teamApi.writeMinutes(team.id, m.id)
        } catch {
          // The meeting is saved; its page shows how to try again.
        }
      }
      onCreated(m, record)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <form
      aria-label="새 회의"
      className={`${card} flex flex-col gap-3 p-4 md:p-5`}
      onSubmit={(e) => {
        e.preventDefault()
        void create(true)
      }}
    >
      <div className="flex flex-col gap-3 md:flex-row">
        <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium text-ink-2">
          제목
          <input autoFocus maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 주간 회의" className={field} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2 md:w-44">
          날짜
          <input type="date" required value={heldOn} onChange={(e) => setHeldOn(e.target.value)} className={field} />
        </label>
      </div>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
        회의 내용
        <textarea
          rows={10}
          maxLength={MAX_TRANSCRIPT}
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          placeholder={'회의 메모나 녹취록을 붙여 넣어 주세요. "이름: 한 말"처럼 줄마다 말한 사람을 적으면 담당자를 더 잘 찾아요.\n\n예)\n김민지: 다음 주 화요일까지 제안서 초안이 필요해요.\n박서준: 제가 목요일까지 쓸게요.'}
          className={area}
        />
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={`${secondaryButton} h-10`} onClick={onCancel}>
          취소
        </button>
        <button type="button" className={`${secondaryButton} h-10`} disabled={saving} onClick={() => void create(false)}>
          저장만 하기
        </button>
        {recordingSupported() && (
          <button type="button" className={`${secondaryButton} h-10`} disabled={saving} onClick={() => void create(false, true)}>
            <Mic size={15} /> 녹음하며 시작
          </button>
        )}
        <button type="submit" className={`${aiButton} h-10`} disabled={saving || !transcript.trim()}>
          <Sparkle size={15} /> 저장하고 AI로 정리
        </button>
      </div>
    </form>
  )
}

type Row = MeetingTask & { key: number }
type MinutesForm = { summary: string; decisions: string; topics: { key: number; title: string; points: string }[] }
let nextKey = 1

const toForm = (m: Minutes | null): MinutesForm => ({
  summary: m?.summary ?? '',
  decisions: (m?.decisions ?? []).join('\n'),
  topics: (m?.topics ?? []).map((t) => ({ key: nextKey++, title: t.title, points: t.points.join('\n') })),
})
const fromForm = (f: MinutesForm): Minutes => ({
  summary: f.summary.trim(),
  decisions: lines(f.decisions),
  topics: f.topics.map((t) => ({ title: t.title.trim(), points: lines(t.points) })).filter((t) => t.title || t.points.length),
})
const toRows = (tasks: MeetingTask[]): Row[] => tasks.map((t) => ({ ...t, key: nextKey++ }))
const fromRows = (rows: Row[]): MeetingTask[] =>
  rows.filter((r) => r.title.trim()).map(({ title, note, evidence, dueDate, assigneeId }) => ({ title: title.trim(), note: note.trim(), evidence, dueDate: dueDate || null, assigneeId }))

interface ViewProps {
  team: TeamDetail
  id: string
  /** Start recording as soon as the meeting is open ("녹음하며 시작"). */
  autoRecord: boolean
  onRecordStarted: () => void
  onBack: () => void
}

function MeetingView({ team, id, autoRecord, onRecordStarted, onBack }: ViewProps) {
  const [m, setM] = useState<Meeting | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [heldOn, setHeldOn] = useState('')
  const [transcript, setTranscript] = useState('')
  const [form, setForm] = useState<MinutesForm>(toForm(null))
  const [rows, setRows] = useState<Row[]>([])
  const [editingMinutes, setEditingMinutes] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [busy, setBusy] = useState(false)
  const [asking, setAsking] = useState<'delete' | 'confirm' | 'rewrite' | `audio:${string}` | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const rec = useMeetingRecorder(team.id, id)
  const recording = rec.state !== 'idle'
  const base = useRef('') // the text before this recording
  const savedText = useRef('')
  const [playing, setPlaying] = useState<string | null>(null)

  const take = useCallback((x: Meeting) => {
    setM(x)
    setTitle(x.title)
    setHeldOn(x.heldOn)
    setTranscript(x.transcript ?? '')
    setForm(toForm(x.minutes))
    setRows(toRows(x.tasks))
    setShowTranscript(!x.minutes)
  }, [])
  useEffect(() => {
    teamApi.meeting(team.id, id).then(take, (e: Error) => setError(e.message))
  }, [team.id, id, take])

  // While the AI works, check on it; take its result when it is done.
  const processing = m?.status === 'processing'
  useEffect(() => {
    if (!processing) return
    const t = setInterval(() => {
      teamApi.meeting(team.id, id).then((x) => (x.status === 'processing' ? setM(x) : take(x)), () => {})
    }, 3000)
    return () => clearInterval(t)
  }, [processing, team.id, id, take])

  // What is heard goes into the meeting's text as it comes, and is saved every half minute.
  useEffect(() => {
    if (rec.state === 'recording' || rec.state === 'stopping') setTranscript(withCaptions(base.current, rec.lines))
  }, [rec.lines, rec.state])
  useEffect(() => {
    if (rec.state !== 'recording') return
    const t = setInterval(() => {
      const text = withCaptions(base.current, rec.lines)
      if (text === savedText.current) return
      savedText.current = text
      teamApi.updateMeeting(team.id, id, { transcript: text }).then(setM, () => {})
    }, 30000)
    return () => clearInterval(t)
  }, [rec.state, rec.lines, team.id, id])

  const startRecording = async () => {
    base.current = transcript
    savedText.current = transcript
    setNotice(null)
    setShowTranscript(true)
    await rec.start()
  }
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!autoRecord || autoStarted.current || !m?.canEdit) return
    autoStarted.current = true
    onRecordStarted()
    void startRecording()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRecord, m?.canEdit])

  if (!m) return <div className="p-2 text-sm text-muted">{error ?? '불러오는 중…'}</div>

  const editable = m.canEdit
  const minutes = fromForm(form)
  const tasks = fromRows(rows)
  const dirty =
    editable &&
    (title.trim() !== m.title ||
      heldOn !== m.heldOn ||
      transcript.trim() !== (m.transcript ?? '') ||
      (m.minutes !== null && JSON.stringify(minutes) !== JSON.stringify(fromForm(toForm(m.minutes)))) ||
      JSON.stringify(tasks) !== JSON.stringify(fromRows(toRows(m.tasks))))
  const unassigned = tasks.filter((t) => !t.assigneeId).length
  const memberName = (userId: string) => {
    const x = team.memberList.find((p) => p.userId === userId)
    return x ? x.name || x.email.split('@')[0] : '담당자 없음'
  }

  const act = async (fn: () => Promise<Meeting | void>, done?: string) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const x = await fn()
      if (x) take(x)
      if (done) setNotice(done)
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
    setAsking(null)
  }
  const body = () => ({ title: title.trim(), heldOn, transcript, ...(m.minutes ? { minutes } : {}), tasks })
  const save = () => act(() => teamApi.updateMeeting(team.id, m.id, body()), '저장했어요')
  const rewrite = () =>
    act(async () => {
      if (dirty) await teamApi.updateMeeting(team.id, m.id, body())
      return teamApi.writeMinutes(team.id, m.id)
    })
  const confirm = () =>
    act(async () => {
      if (dirty) await teamApi.updateMeeting(team.id, m.id, body())
      return teamApi.confirmMeeting(team.id, m.id, tasks)
    }, `할 일 ${tasks.length}개를 팀 업무로 만들었어요`)
  const remove = () =>
    act(async () => {
      await teamApi.deleteMeeting(team.id, m.id)
      onBack()
    })
  const stopRecording = (thenSummarize: boolean) =>
    act(async () => {
      const r = await rec.stop()
      const text = withCaptions(base.current, r.lines)
      let x = await teamApi.updateMeeting(team.id, m.id, { transcript: text })
      const length = r.audio ? ` (${clock(r.audio.durationSec)})` : ''
      const cut = r.lost ? ` 녹음 조각 ${r.lost}개를 보내지 못해 그 부분이 빠졌어요.` : ''
      if (thenSummarize && text.trim()) {
        x = await teamApi.writeMinutes(team.id, m.id)
        take(x)
      } else {
        // Keep edits to the title, minutes and tasks made while recording.
        setM(x)
        setTranscript(x.transcript ?? '')
      }
      setNotice(
        r.lines.length
          ? `녹음${length}과 자막을 저장했어요.${cut}${thenSummarize ? '' : ' 자막을 고친 뒤 AI로 회의록을 정리할 수 있어요.'}`
          : `녹음${length}을 저장했어요.${cut} 자막이 없어서 회의 내용은 직접 적어야 해요.`,
      )
    })
  const removeAudio = (audioId: string) =>
    act(async () => {
      await teamApi.deleteAudio(team.id, m.id, audioId)
      setM({ ...m, audio: m.audio.filter((a) => a.id !== audioId) })
    })

  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const setTopic = (i: number, patch: Partial<MinutesForm['topics'][number]>) => setForm({ ...form, topics: form.topics.map((t, j) => (j === i ? { ...t, ...patch } : t)) })

  return (
    <section aria-label={m.title} className="flex flex-col gap-3 md:gap-4">
      <button onClick={onBack} disabled={recording} title={recording ? '녹음을 끝낸 뒤 나갈 수 있어요' : undefined} className="flex w-fit items-center gap-1 rounded-lg py-1 pr-2 text-sm text-muted hover:text-ink disabled:opacity-40">
        <ChevronLeft size={16} /> 회의 목록
      </button>

      <div className={`${card} flex flex-col gap-3 p-4 md:p-5`}>
        {editable ? (
          <div className="flex flex-col gap-3 md:flex-row">
            <input aria-label="회의 제목" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={`${field} text-base font-semibold md:flex-1 md:text-base`} />
            <input aria-label="회의 날짜" type="date" required value={heldOn} onChange={(e) => setHeldOn(e.target.value)} className={`${field} md:w-44`} />
          </div>
        ) : (
          <h2 className="text-lg font-semibold">
            {m.title} <span className="ml-1 font-mono text-sm font-normal text-muted">{dayText(m.heldOn)}</span>
          </h2>
        )}
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <StatusPill m={m} />
          <span>{m.createdByName || '알 수 없음'} 님이 만듦</span>
          {m.confirmedAt && <span>· {m.confirmedByName || '알 수 없음'} 님이 확정</span>}
        </p>
        {processing && (
          <div role="status" className="flex items-center gap-2.5 rounded-xl bg-ai-soft px-3.5 py-3 text-sm text-ai-ink">
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ai border-t-transparent" />
            AI가 회의록을 정리하고 있어요{m.aiParts > 1 ? ` · ${m.aiDone}/${m.aiParts}단계` : ''}. 로컬 AI는 몇 분 걸릴 수 있어요. 이 화면을 떠나도 계속되고, 끝나면 알림을 보내요.
          </div>
        )}
        {m.aiError && !processing && <AIError error={m.aiError} />}
      </div>

      <section aria-label="회의 내용" className={`${card} flex flex-col gap-3 p-4 md:p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button onClick={() => setShowTranscript(!showTranscript)} className="shrink-0 whitespace-nowrap text-left text-[15px] font-semibold" aria-expanded={showTranscript}>
            회의 내용 <span className="text-xs font-normal text-muted">{showTranscript ? '접기' : `펼치기 · ${transcript.length.toLocaleString()}자`}</span>
          </button>
          {editable && !recording && (
            <span className="flex flex-wrap justify-end gap-2">
              {recordingSupported() && (
                <button className={`${secondaryButton} h-9 text-xs`} disabled={busy} onClick={() => void startRecording()}>
                  <Mic size={14} /> 회의 녹음
                </button>
              )}
              <button className={`${aiOutlineButton} h-9 text-xs`} disabled={busy || !transcript.trim()} onClick={() => (m.minutes ? setAsking('rewrite') : void rewrite())}>
                <Sparkle size={13} /> {m.minutes ? 'AI로 다시 정리' : 'AI로 회의록 정리'}
              </button>
            </span>
          )}
        </div>
        {rec.error && <p className="text-sm text-danger">{rec.error}</p>}
        {recording && (
          <div role="status" aria-label="녹음 중" className="flex flex-col gap-2.5 rounded-xl border border-danger/30 bg-danger/5 px-3.5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-danger" aria-hidden="true" />
              <span className="text-sm font-semibold text-ink">{rec.state === 'starting' ? '마이크 준비 중…' : rec.state === 'stopping' ? '녹음 저장 중…' : '녹음 중'}</span>
              <span className="font-mono text-sm text-ink-2">{clock(rec.elapsed)}</span>
              {rec.unsent > 1 && <span className="text-xs text-muted">보낼 조각 {rec.unsent}개</span>}
              <span className="ml-auto flex gap-2">
                <button className={`${secondaryButton} h-9 text-xs`} disabled={rec.state !== 'recording'} onClick={() => void stopRecording(false)}>
                  녹음 끝내기
                </button>
                <button className={`${aiButton} h-9 text-xs`} disabled={rec.state !== 'recording'} onClick={() => void stopRecording(true)}>
                  <Sparkle size={13} /> 끝내고 AI로 정리
                </button>
              </span>
            </div>
            {captionsSupported() ? (
              <div aria-label="실시간 자막" aria-live="polite" className="flex max-h-48 flex-col-reverse overflow-y-auto rounded-lg bg-surface px-3 py-2 text-sm leading-relaxed">
                <p>
                  {rec.lines.slice(-30).map((l, i) => (
                    <span key={i} className="block text-ink-2">
                      {l}
                    </span>
                  ))}
                  {rec.interim && <span className="block text-muted">{rec.interim}</span>}
                  {!rec.lines.length && !rec.interim && <span className="block text-muted">말소리를 기다리고 있어요…</span>}
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted">이 브라우저는 실시간 자막을 지원하지 않아요(Chrome·Edge·Safari에서 돼요). 녹음은 저장돼요.</p>
            )}
            {rec.captionError && <p className="text-xs text-danger">{rec.captionError}</p>}
            <p className="text-xs text-muted">자막은 브라우저 음성 인식이라 틀릴 수 있어요. 녹음이 끝나면 고칠 수 있고, 녹음 파일도 함께 저장돼요.</p>
          </div>
        )}
        {asking === 'rewrite' && (
          <ConfirmInline message="지금 회의록과 할 일을 AI가 새로 정리한 것으로 바꿔요." confirmLabel="다시 정리" onConfirm={() => void rewrite()} onCancel={() => setAsking(null)} />
        )}
        {showTranscript &&
          !recording &&
          (editable ? (
            <textarea aria-label="회의 내용" rows={12} maxLength={MAX_TRANSCRIPT} value={transcript} onChange={(e) => setTranscript(e.target.value)} placeholder="회의 메모나 녹취록을 붙여 넣거나, 회의 녹음을 눌러 자막으로 받아 적어 보세요." className={area} />
          ) : (
            <p className="max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-xl bg-subtle px-3.5 py-3 text-sm leading-relaxed text-ink-2">{m.transcript || '내용이 없어요.'}</p>
          ))}
        {m.audio.length > 0 && (
          <ul aria-label="녹음 파일" className="flex flex-col gap-1.5">
            {m.audio.map((a, i) => (
              <li key={a.id} aria-label={`녹음 ${i + 1}`} className="flex flex-col gap-1.5 rounded-xl bg-subtle px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
                  <Mic size={13} />
                  <span className="font-semibold">녹음 {i + 1}</span>
                  {a.durationSec > 0 && <span className="font-mono">{clock(a.durationSec)}</span>}
                  <span className="font-mono text-muted">{fileSize(a.bytes)}</span>
                  <span className="text-muted">{a.createdByName}</span>
                  {!a.finished && !recording && <span className="text-danger">중간에 끊긴 녹음</span>}
                  <span className="ml-auto flex gap-1">
                    {a.bytes > 0 && playing !== a.id && (
                      <button className="rounded-md px-2 py-1 hover:bg-surface" onClick={() => setPlaying(a.id)}>
                        듣기
                      </button>
                    )}
                    <a className="rounded-md px-2 py-1 hover:bg-surface" href={teamApi.audioURL(team.id, m.id, a.id)} download>
                      받기
                    </a>
                    {m.canDelete && !recording && (
                      <button className="rounded-md px-2 py-1 text-danger hover:bg-surface" disabled={busy} onClick={() => setAsking(`audio:${a.id}`)}>
                        삭제
                      </button>
                    )}
                  </span>
                </div>
                {playing === a.id && <audio controls autoPlay src={teamApi.audioURL(team.id, m.id, a.id)} className="h-9 w-full" />}
                {asking === `audio:${a.id}` && (
                  <ConfirmInline message="이 녹음 파일을 지워요. 회의 내용은 그대로예요." onConfirm={() => void removeAudio(a.id)} onCancel={() => setAsking(null)} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {m.minutes && (
        <section aria-label="회의록" className={`${card} flex flex-col gap-3 p-4 md:p-5`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold">회의록</h3>
            {editable && (
              <button className={`${secondaryButton} h-8 px-3 text-xs`} onClick={() => setEditingMinutes(!editingMinutes)}>
                {editingMinutes ? '편집 끝' : '편집'}
              </button>
            )}
          </div>
          {editingMinutes ? (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                요약
                <textarea rows={3} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} className={area} />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                결정 사항 <span className="text-xs font-normal text-muted">한 줄에 하나씩</span>
                <textarea rows={3} value={form.decisions} onChange={(e) => setForm({ ...form, decisions: e.target.value })} className={area} />
              </label>
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-ink-2">논의 내용</span>
                {form.topics.map((t, i) => (
                  <div key={t.key} className="flex flex-col gap-1.5 rounded-xl border border-line p-3">
                    <div className="flex gap-2">
                      <input aria-label="주제" value={t.title} onChange={(e) => setTopic(i, { title: e.target.value })} placeholder="주제" className={`${small} flex-1 font-medium`} />
                      <button aria-label="주제 삭제" className="rounded-md p-2 text-muted hover:bg-subtle" onClick={() => setForm({ ...form, topics: form.topics.filter((_, j) => j !== i) })}>
                        <Close size={14} />
                      </button>
                    </div>
                    <textarea aria-label={`${t.title} 내용`} rows={3} value={t.points} onChange={(e) => setTopic(i, { points: e.target.value })} placeholder="한 줄에 하나씩" className={area} />
                  </div>
                ))}
                <button className={`${secondaryButton} h-9 w-fit text-xs`} onClick={() => setForm({ ...form, topics: [...form.topics, { key: nextKey++, title: '', points: '' }] })}>
                  <Plus size={14} /> 주제 추가
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-sm leading-relaxed">
              {minutes.summary && <p className="text-ink">{minutes.summary}</p>}
              {minutes.decisions.length > 0 && (
                <div>
                  <h4 className="mb-1 text-xs font-semibold text-ink-2">결정 사항</h4>
                  <ul className="flex list-disc flex-col gap-0.5 pl-5">
                    {minutes.decisions.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
              )}
              {minutes.topics.map((t, i) => (
                <div key={i}>
                  <h4 className="mb-1 text-xs font-semibold text-ink-2">{t.title}</h4>
                  <ul className="flex list-disc flex-col gap-0.5 pl-5 text-ink-2">
                    {t.points.map((p, j) => (
                      <li key={j}>{p}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {(m.minutes || rows.length > 0) && (
        <section aria-label="할 일" className={`${card} flex flex-col gap-3 p-4 md:p-5`}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold">
              할 일 <span className="text-xs font-normal text-muted">{tasks.length}개</span>
            </h3>
            {m.status === 'confirmed' && <span className="text-xs text-muted">팀 업무 탭에서 진행 상황을 볼 수 있어요</span>}
          </div>
          {rows.length === 0 && <p className="rounded-xl border border-dashed border-line px-3 py-4 text-center text-sm text-muted">찾은 할 일이 없어요.{editable && ' 직접 추가할 수 있어요.'}</p>}
          <ul className="flex flex-col gap-2">
            {rows.map((r, i) => (
              <li key={r.key} aria-label={r.title || `할 일 ${i + 1}`} className="flex flex-col gap-2 rounded-xl border border-line px-3 py-2.5">
                {editable ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex min-w-[220px] flex-1 items-center gap-1 md:contents">
                        <input aria-label="할 일" maxLength={200} value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} placeholder="할 일" className={`${small} min-w-0 flex-1 font-medium`} />
                        <button aria-label={`${r.title} 삭제`} className="rounded-md p-2 text-muted hover:bg-subtle md:order-last" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                          <Close size={14} />
                        </button>
                      </span>
                      <select aria-label={`${r.title} 담당자`} value={r.assigneeId} onChange={(e) => setRow(i, { assigneeId: e.target.value })} className={small}>
                        <option value="">담당자 없음</option>
                        {team.memberList.map((p) => (
                          <option key={p.userId} value={p.userId}>
                            {p.name || p.email.split('@')[0]}
                          </option>
                        ))}
                      </select>
                      <input aria-label={`${r.title} 마감일`} type="date" value={r.dueDate ?? ''} onChange={(e) => setRow(i, { dueDate: e.target.value || null })} className={small} />
                    </div>
                    <input aria-label={`${r.title} 메모`} maxLength={1000} value={r.note} onChange={(e) => setRow(i, { note: e.target.value })} placeholder="메모 (선택)" className={`${small} text-xs`} />
                  </>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="min-w-0 flex-1 text-sm font-medium">{r.title}</span>
                    <span className="text-xs text-ink-2">{memberName(r.assigneeId)}</span>
                    {r.dueDate && <span className="font-mono text-xs text-muted">~{dayText(r.dueDate)}</span>}
                    {r.note && <span className="w-full text-xs text-muted">{r.note}</span>}
                  </div>
                )}
                {r.evidence && <p className="text-xs text-muted">근거: “{r.evidence}”</p>}
              </li>
            ))}
          </ul>
          {editable && (
            <button
              className={`${secondaryButton} h-9 w-fit text-xs`}
              onClick={() => setRows([...rows, { key: nextKey++, title: '', note: '', evidence: '', dueDate: null, assigneeId: '' }])}
            >
              <Plus size={14} /> 할 일 추가
            </button>
          )}
        </section>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}
      {notice && <p className="text-sm text-good">{notice}</p>}
      {asking === 'delete' && <ConfirmInline message="이 회의를 지워요. 이미 만든 팀 업무는 남아요." onConfirm={() => void remove()} onCancel={() => setAsking(null)} />}
      {asking === 'confirm' && (
        <ConfirmInline
          message={`할 일 ${tasks.length}개를 팀 업무로 만들고 담당자에게 알려요.${unassigned ? ` 담당자가 없는 할 일 ${unassigned}개는 담당자 없이 만들어요.` : ''} 확정하면 회의를 더 고칠 수 없어요.`}
          confirmLabel="확정"
          onConfirm={() => void confirm()}
          onCancel={() => setAsking(null)}
        />
      )}
      {(editable || m.canConfirm || m.canDelete) && (
        <div className="flex flex-wrap items-center gap-2">
          {m.canDelete && (
            <button className="mr-auto rounded-lg px-2 py-2 text-sm text-danger hover:bg-danger/5" disabled={busy || recording} onClick={() => setAsking('delete')}>
              회의 삭제
            </button>
          )}
          {editable && (
            <button className={`${secondaryButton} h-10`} disabled={busy || recording || !dirty || !title.trim()} onClick={() => void save()}>
              저장
            </button>
          )}
          {m.canConfirm && m.minutes && (
            <button className={`${primaryButton} h-10`} disabled={busy || recording || !title.trim()} onClick={() => setAsking('confirm')}>
              확정하고 팀 업무 만들기
            </button>
          )}
        </div>
      )}
      {!editable && m.status !== 'confirmed' && !m.canConfirm && <p className="text-xs text-muted">회의를 만든 사람과 매니저가 고치고, 매니저가 확정해요.</p>}
    </section>
  )
}
