import { useEffect, useRef, useState, type Ref } from 'react'
import { api } from '../../api/client'
import type { AssistantChange, AssistantOp } from '../../api/types'
import { ArrowUp, Close, Mic, Sparkle } from '../../components/icons'
import { aiButton, srOnly } from '../../components/styles'
import { parseISODate } from '../../lib/date'
import { slotToTime } from '../../lib/slots'
import { cleanTranscript } from '../../lib/transcript'
import { useSpeech } from '../../lib/useSpeech'
import type { AssistantState } from './useAssistant'
import { AIError } from '../../components/AIError'
import { useAIQueue } from '../../lib/useAIQueue'

interface BarProps {
  assistant: AssistantState
  inputRef?: Ref<HTMLInputElement>
  /** Start listening as soon as the bar mounts (phone mic button). */
  listenOnMount?: boolean
  showShortcut?: boolean
}

/** Where the dictated text is: being tidied by Claude, tidied (original kept), or left as spoken. */
type Tidy =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'done'; original: string; tidied: string; showing: 'tidied' | 'original' }
  | { status: 'failed' }

/**
 * Text field with dictation: words appear in the field as they are spoken,
 * after anything already typed. When listening stops Claude rewrites the whole
 * thing into a short request and puts it in the field. Nothing is sent until
 * the person presses the arrow themselves.
 */
export function AssistantBar({ assistant, inputRef, listenOnMount, showShortcut }: BarProps) {
  const [text, setText] = useState('')
  // True while the field holds an unedited transcript, to point at the send arrow.
  const [fromVoice, setFromVoice] = useState(false)
  const [tidy, setTidy] = useState<Tidy>({ status: 'idle' })
  const tidyAbort = useRef<AbortController | null>(null)
  const fieldRef = useRef<HTMLInputElement | null>(null)
  // What was typed before dictation started; spoken words are appended to it.
  const prefixRef = useRef('')
  const busy = assistant.status === 'loading' || assistant.status === 'applying'
  const putText = (value: string) => {
    setText(value)
    // Put the caret at the end so a quick fix is one keystroke away.
    requestAnimationFrame(() => {
      const el = fieldRef.current
      el?.focus()
      el?.setSelectionRange(value.length, value.length)
    })
  }

  const cancelTidy = () => {
    tidyAbort.current?.abort()
    tidyAbort.current = null
  }

  const speech = useSpeech((spoken) => {
    const cleaned = cleanTranscript(join(prefixRef.current, spoken))
    if (!cleaned) return
    putText(cleaned)
    setFromVoice(true)
    cancelTidy()
    const ctrl = new AbortController()
    tidyAbort.current = ctrl
    setTidy({ status: 'working' })
    api.assistantTidy(cleaned, ctrl.signal).then(
      ({ text: tidied }) => {
        if (ctrl.signal.aborted) return
        tidyAbort.current = null
        putText(tidied)
        setTidy({ status: 'done', original: cleaned, tidied, showing: 'tidied' })
      },
      () => {
        if (ctrl.signal.aborted) return
        tidyAbort.current = null
        setTidy({ status: 'failed' })
      },
    )
  })

  useEffect(() => cancelTidy, [])

  const setRefs = (el: HTMLInputElement | null) => {
    fieldRef.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el
  }

  const startListening = () => {
    cancelTidy()
    setTidy({ status: 'idle' })
    prefixRef.current = text.trim()
    speech.start()
  }

  useEffect(() => {
    if (listenOnMount && speech.supported) startListening()
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = speech.listening ? join(prefixRef.current, speech.transcript) : text

  // Keep the newest words in view while they stream in.
  useEffect(() => {
    const el = fieldRef.current
    if (speech.listening && el) el.scrollLeft = el.scrollWidth
  }, [speech.listening, value])

  return (
    <div className="flex flex-col gap-1.5">
      <form
        className={`flex items-center gap-1.5 rounded-xl border bg-surface py-1 pr-1 pl-3.5 ${
          speech.listening ? 'border-ai shadow-[0_0_0_3px_rgba(109,74,255,0.15)]' : 'border-line-strong focus-within:border-ai'
        }`}
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim() || busy || tidy.status === 'working') return
          void assistant.ask(text)
          setText('')
          setFromVoice(false)
          setTidy({ status: 'idle' })
        }}
      >
        <Sparkle size={16} className="shrink-0 text-ai" />
        <label htmlFor="assistant-input" className={srOnly}>
          말로 요청하기
        </label>
        <input
          id="assistant-input"
          ref={setRefs}
          value={value}
          readOnly={speech.listening || tidy.status === 'working'}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value)
            setFromVoice(false)
          }}
          placeholder={speech.listening ? '듣고 있어요… 말을 다 하면 정리해서 여기에 넣어 드려요' : '말로 요청하기 · 예: 헬스장 8시로 미루고 내일 3시에 치과 넣어줘'}
          className="h-10 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint md:text-sm"
        />
        {showShortcut && !text && !speech.listening && (
          <kbd className="hidden rounded-md border border-line px-1.5 font-mono text-[11px] text-faint lg:inline">⌘K</kbd>
        )}
        {speech.supported && (
          <button
            type="button"
            onClick={speech.listening ? speech.stop : startListening}
            disabled={busy}
            aria-label={speech.listening ? '듣기 멈추기' : '음성으로 말하기'}
            aria-pressed={speech.listening}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] disabled:opacity-40 ${
              speech.listening ? 'animate-pulse bg-ai text-white' : 'text-ai-ink hover:bg-ai-soft'
            }`}
          >
            {speech.listening ? <span className="h-3.5 w-3.5 rounded-[3px] bg-current" aria-hidden="true" /> : <Mic size={18} />}
          </button>
        )}
        <button
          type="submit"
          aria-label="보내기"
          disabled={!text.trim() || busy || speech.listening || tidy.status === 'working'}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-ai text-white disabled:opacity-30 ${
            fromVoice ? 'ring-4 ring-ai/30' : ''
          }`}
        >
          <ArrowUp size={18} />
        </button>
      </form>
      {speech.listening && (
        <p role="status" className="flex items-center gap-1.5 pl-1 text-xs text-ai-ink">
          <span className="h-2 w-2 animate-pulse rounded-full bg-ai" aria-hidden="true" />
          듣고 있어요 · 다 말했으면 ■ 버튼을 누르세요 (5초 동안 조용하면 자동으로 멈춰요)
        </p>
      )}
      {speech.error && <p className="pl-1 text-xs text-danger">{speech.error}</p>}
      {fromVoice && !speech.error && tidy.status === 'working' && (
        <p role="status" className="flex items-center gap-1.5 pl-1 text-xs text-ai-ink">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-ai border-t-transparent" aria-hidden="true" />
          말한 내용을 AI가 정리하는 중이에요…
        </p>
      )}
      {fromVoice && !speech.error && tidy.status === 'done' && (
        <p role="status" className="flex flex-wrap items-center gap-x-2 pl-1 text-xs text-ai-ink">
          {tidy.showing === 'tidied' ? 'AI가 정리했어요.' : '말한 그대로예요.'} 확인하고 ↑ 버튼을 눌러 보내세요.
          <button
            type="button"
            className="font-semibold underline"
            onClick={() => {
              const next = tidy.showing === 'tidied' ? 'original' : 'tidied'
              putText(next === 'tidied' ? tidy.tidied : tidy.original)
              setTidy({ ...tidy, showing: next })
            }}
          >
            {tidy.showing === 'tidied' ? '말한 그대로 보기' : '정리한 문장 보기'}
          </button>
        </p>
      )}
      {fromVoice && !speech.error && tidy.status === 'failed' && (
        <p role="status" className="pl-1 text-xs text-ink-2">
          정리하지 못해서 말한 그대로 두었어요. 확인하고 ↑ 버튼을 눌러 보내세요.
        </p>
      )}
    </div>
  )
}

/** Joins typed text and spoken text with one space. */
function join(before: string, after: string) {
  return [before, after.trim()].filter(Boolean).join(' ')
}

const KIND_LABEL: Record<AssistantChange['kind'], string> = {
  add: '추가',
  move: '이동',
  edit: '수정',
  done: '완료',
  undone: '완료 취소',
  remove: '삭제',
  'item-add': '할 일 추가',
  'item-edit': '할 일 수정',
  'item-remove': '할 일 삭제',
}

function spanText(span: { date: string; startSlot: number; endSlot: number }, viewDate: string) {
  const time = `${slotToTime(span.startSlot)}–${slotToTime(span.endSlot)}`
  if (span.date === viewDate) return time
  const d = parseISODate(span.date)
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`
}

function changeWhen(c: AssistantChange, viewDate: string) {
  if (c.kind === 'move' && c.before && c.after) return `${spanText(c.before, viewDate)} → ${spanText(c.after, viewDate)}`
  if (c.kind === 'remove' && c.before) return spanText(c.before, viewDate)
  if (c.after && c.kind !== 'edit') return spanText(c.after, viewDate)
  return c.detail ?? ''
}

interface PanelProps {
  assistant: AssistantState
  viewDate: string
  onApplied: (result: { undo: AssistantOp[]; count: number }) => void
  onClose: () => void
}

/** The conversation's latest turn: Claude's answer and the edits waiting for confirmation. */
export function AssistantPanel({ assistant, viewDate, onApplied, onClose }: PanelProps) {
  const { status, preview, message, error } = assistant
  const waiting = useAIQueue(status === 'loading')
  const applyRef = useRef<HTMLButtonElement>(null)
  const hasRemoval = preview?.changes.some((c) => c.kind === 'remove' || c.kind === 'item-remove')

  useEffect(() => {
    if (status === 'ready' && preview?.ops.length) applyRef.current?.focus()
  }, [status, preview])

  if (status === 'idle' && !error) return null

  return (
    <section aria-label="요청 결과" aria-live="polite" className="flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted">
          <span className="text-faint">요청 · </span>“{message}”
        </p>
        <button onClick={onClose} aria-label="요청 닫기" className="-mt-1 -mr-1 rounded-lg p-1.5 text-muted hover:bg-subtle">
          <Close size={16} />
        </button>
      </div>

      {status === 'loading' && (
        <div role="status" className="flex items-center gap-2.5 rounded-xl bg-ai-soft px-3.5 py-3 text-sm text-ai-ink">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ai border-t-transparent" />
          {waiting > 0 ? `AI 대기 중이에요 · 앞에 ${waiting}건` : '요청을 이해하고 있어요… 보통 5~15초 걸려요.'}
        </div>
      )}
      {error && <AIError error={error} />}

      {preview && status !== 'loading' && (
        <>
          {preview.clarification ? (
            <p className="rounded-xl bg-ai-soft px-3.5 py-3 text-sm leading-relaxed text-ai-ink">
              {preview.clarification}
              <span className="mt-1 block text-xs opacity-80">위 입력창에 답해 주세요.</span>
            </p>
          ) : (
            preview.reply && <p className="rounded-xl bg-ai-soft px-3.5 py-3 text-sm leading-relaxed text-ai-ink">{preview.reply}</p>
          )}

          {preview.changes.length > 0 && (
            <ul className="flex flex-col gap-1.5" aria-label="바뀌는 내용">
              {preview.changes.map((c, i) => {
                const removal = c.kind === 'remove' || c.kind === 'item-remove'
                return (
                  <li
                    key={i}
                    className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${removal ? 'border-danger/40 bg-danger/5' : 'border-line'}`}
                  >
                    <span
                      className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
                        removal ? 'bg-danger/15 text-danger' : c.kind === 'add' || c.kind === 'item-add' ? 'bg-ai-soft text-ai-ink' : 'bg-subtle text-ink-2'
                      }`}
                    >
                      {KIND_LABEL[c.kind]}
                    </span>
                    <span className={`min-w-0 flex-1 truncate font-medium ${removal ? 'line-through decoration-danger' : ''}`}>{c.title}</span>
                    <span className="shrink-0 font-mono text-xs text-muted">{changeWhen(c, viewDate)}</span>
                  </li>
                )
              })}
            </ul>
          )}

          {preview.warnings.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs text-ink-2">
              {preview.warnings.map((w, i) => (
                <li key={i}>
                  <span className="font-semibold text-danger">확인 필요 · </span>
                  {w}
                </li>
              ))}
            </ul>
          )}

          {preview.ops.length > 0 ? (
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="h-11 rounded-xl px-4 text-sm text-ink-2 hover:bg-subtle">
                취소
              </button>
              <button
                ref={applyRef}
                onClick={async () => {
                  const res = await assistant.apply()
                  if (res) onApplied(res)
                }}
                disabled={status === 'applying'}
                className={`${aiButton} h-11 min-w-32 ${hasRemoval ? 'bg-danger' : ''}`}
              >
                {status === 'applying' ? '적용하는 중…' : `${preview.changes.length}개 적용${hasRemoval ? ' (삭제 포함)' : ''}`}
              </button>
            </div>
          ) : (
            !preview.clarification && <p className="text-sm text-muted">바꿀 내용이 없어요.</p>
          )}
        </>
      )}
    </section>
  )
}
