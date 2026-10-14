import { useEffect, useRef, useState, type Ref } from 'react'
import type { AssistantChange, AssistantOp } from '../../api/types'
import { ArrowUp, Close, Mic, Sparkle } from '../../components/icons'
import { aiButton, srOnly } from '../../components/styles'
import { parseISODate } from '../../lib/date'
import { slotToTime } from '../../lib/slots'
import { useSpeech } from '../../lib/useSpeech'
import type { AssistantState } from './useAssistant'

interface BarProps {
  assistant: AssistantState
  inputRef?: Ref<HTMLInputElement>
  /** Start listening as soon as the bar mounts (phone mic button). */
  listenOnMount?: boolean
  showShortcut?: boolean
}

/** Text field with a mic: speaking fills it in and sends when you stop talking. */
export function AssistantBar({ assistant, inputRef, listenOnMount, showShortcut }: BarProps) {
  const [text, setText] = useState('')
  const busy = assistant.status === 'loading' || assistant.status === 'applying'
  const speech = useSpeech((final) => {
    setText('')
    void assistant.ask(final)
  })

  useEffect(() => {
    if (listenOnMount && speech.supported) speech.start()
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = speech.listening ? speech.interim : text

  return (
    <div className="flex flex-col gap-1.5">
      <form
        className={`flex items-center gap-1.5 rounded-xl border bg-surface py-1 pr-1 pl-3.5 ${
          speech.listening ? 'border-ai shadow-[0_0_0_3px_rgba(109,74,255,0.15)]' : 'border-line-strong focus-within:border-ai'
        }`}
        onSubmit={(e) => {
          e.preventDefault()
          if (!text.trim() || busy) return
          void assistant.ask(text)
          setText('')
        }}
      >
        <Sparkle size={16} className="shrink-0 text-ai" />
        <label htmlFor="assistant-input" className={srOnly}>
          말로 요청하기
        </label>
        <input
          id="assistant-input"
          ref={inputRef}
          value={value}
          readOnly={speech.listening}
          onChange={(e) => setText(e.target.value)}
          placeholder={speech.listening ? '듣고 있어요… 말해 보세요' : '말로 요청하기 · 예: 헬스장 8시로 미루고 내일 3시에 치과 넣어줘'}
          className="h-10 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint md:text-sm"
        />
        {showShortcut && !text && !speech.listening && (
          <kbd className="hidden rounded-md border border-line px-1.5 font-mono text-[11px] text-faint lg:inline">⌘K</kbd>
        )}
        {speech.supported && (
          <button
            type="button"
            onClick={speech.listening ? speech.stop : speech.start}
            disabled={busy}
            aria-label={speech.listening ? '듣기 멈추기' : '음성으로 말하기'}
            aria-pressed={speech.listening}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] disabled:opacity-40 ${
              speech.listening ? 'animate-pulse bg-ai text-white' : 'text-ai-ink hover:bg-ai-soft'
            }`}
          >
            <Mic size={18} />
          </button>
        )}
        <button
          type="submit"
          aria-label="보내기"
          disabled={!text.trim() || busy || speech.listening}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-ai text-white disabled:opacity-30"
        >
          <ArrowUp size={18} />
        </button>
      </form>
      {speech.error && <p className="pl-1 text-xs text-danger">{speech.error}</p>}
    </div>
  )
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
          요청을 이해하고 있어요… 보통 5~15초 걸려요.
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-danger/10 px-3.5 py-3 text-sm text-danger">
          {error}
        </p>
      )}

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
