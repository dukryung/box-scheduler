import { useCallback, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { AssistantOp, AssistantPreview, AssistantTurn } from '../../api/types'
import { todayISO } from '../../lib/date'

type Status = 'idle' | 'loading' | 'ready' | 'applying'

function nowHM() {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A spoken/typed request → previewed edits → apply (with undo) for one viewed day. */
export function useAssistant(viewDate: string) {
  const [status, setStatus] = useState<Status>('idle')
  const [preview, setPreview] = useState<AssistantPreview | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const history = useRef<AssistantTurn[]>([])
  const abortRef = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    abortRef.current?.abort()
    history.current = []
    setStatus('idle')
    setPreview(null)
    setMessage('')
    setError(null)
  }, [])

  async function ask(text: string) {
    const msg = text.trim()
    if (!msg) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setMessage(msg)
    setStatus('loading')
    setError(null)
    try {
      const res = await api.assistantPreview(
        { message: msg, history: history.current, viewDate, today: todayISO(), now: nowHM() },
        controller.signal,
      )
      // Follow-ups ("아니 4시로") need what was said before.
      history.current = [
        ...history.current,
        { role: 'user' as const, text: msg },
        { role: 'assistant' as const, text: res.clarification || res.reply || '바꿀 내용이 없어요' },
      ].slice(-6)
      setPreview(res)
      setStatus('ready')
    } catch (e) {
      if (controller.signal.aborted) return
      setError((e as Error).message)
      setStatus(preview ? 'ready' : 'idle')
    }
  }

  /** Saves the previewed ops; returns the ops that undo them, or null on failure. */
  async function apply(): Promise<{ undo: AssistantOp[]; count: number } | null> {
    if (!preview || preview.ops.length === 0) return null
    setStatus('applying')
    setError(null)
    try {
      const { undo } = await api.assistantApply(preview.ops)
      const count = preview.changes.length
      reset()
      return { undo, count }
    } catch (e) {
      setError((e as Error).message)
      setStatus('ready')
      return null
    }
  }

  return { status, preview, message, error, ask, apply, reset }
}

export type AssistantState = ReturnType<typeof useAssistant>
