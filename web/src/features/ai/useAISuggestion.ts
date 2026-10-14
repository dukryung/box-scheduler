import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { SuggestedBlock, Suggestion } from '../../api/types'

type Status = 'idle' | 'loading' | 'ready' | 'applying'

const blockKey = (b: SuggestedBlock) => `${b.taskId}:${b.startSlot}`

/** Requesting, previewing, picking, and applying an AI plan for one day. */
export function useAISuggestion(date: string) {
  const [status, setStatus] = useState<Status>('idle')
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const [hovered, setHovered] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setStatus('idle')
    setSuggestion(null)
    setError(null)
    setRejected(new Set())
    setHovered(null)
  }, [])

  // A plan only makes sense for the day it was made for.
  useEffect(() => reset, [date, reset])

  async function request(fromSlot: number, toSlot: number) {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setStatus('loading')
    setError(null)
    try {
      const res = await api.aiSuggest(date, fromSlot, toSlot, controller.signal)
      setSuggestion(res)
      setRejected(new Set())
      setStatus('ready')
    } catch (e) {
      if (controller.signal.aborted) return
      setError((e as Error).message)
      setStatus(suggestion ? 'ready' : 'idle')
    }
  }

  function cancel() {
    abortRef.current?.abort()
    setStatus(suggestion ? 'ready' : 'idle')
  }

  function toggle(b: SuggestedBlock) {
    setRejected((prev) => {
      const next = new Set(prev)
      const key = blockKey(b)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const accepted = suggestion?.blocks.filter((b) => !rejected.has(blockKey(b))) ?? []

  /** Saves the accepted blocks; returns how many were added, or null on failure. */
  async function apply(): Promise<number | null> {
    if (!suggestion || accepted.length === 0) return null
    setStatus('applying')
    setError(null)
    try {
      const acceptedTasks = new Set(accepted.map((b) => b.taskId))
      const estimates = suggestion.estimates.filter((e) => acceptedTasks.has(e.taskId))
      const created = await api.aiApply(date, accepted, estimates)
      reset()
      return created.length
    } catch (e) {
      setError((e as Error).message)
      setStatus('ready')
      return null
    }
  }

  return {
    status,
    suggestion,
    error,
    accepted,
    hovered,
    setHovered,
    isAccepted: (b: SuggestedBlock) => !rejected.has(blockKey(b)),
    blockKey,
    request,
    cancel,
    toggle,
    apply,
    reset,
  }
}

export type AISuggestionState = ReturnType<typeof useAISuggestion>
