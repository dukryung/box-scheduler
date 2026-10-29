import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client'
import type { AppliedPlan, SuggestedBlock, Suggestion } from '../../api/types'
import { diffSuggestion, type SuggestionDiff } from '../../lib/suggestionDiff'

type Status = 'idle' | 'loading' | 'revising' | 'ready' | 'applying'

const blockKey = (b: SuggestedBlock) => `${b.taskId}:${b.startSlot}`

/** Requesting, previewing, picking, and applying an AI plan for one day. */
export function useAISuggestion(date: string) {
  const [status, setStatus] = useState<Status>('idle')
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rejected, setRejected] = useState<Set<string>>(new Set())
  const [hovered, setHovered] = useState<string | null>(null)
  // Changes asked for on the current suggestion, oldest first, and what the last one changed.
  const [requests, setRequests] = useState<string[]>([])
  const [diff, setDiff] = useState<SuggestionDiff | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const paramsRef = useRef({ fromSlot: 0, toSlot: 0, includeBacklog: false })
  // The break between blocks: the panel's setting, until a change request asks for another one.
  const [breakMinutes, setBreakMinutes] = useState(0)
  useEffect(() => {
    let live = true
    api
      .planBreak()
      .then((r) => live && setBreakMinutes(r.breakMinutes))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  /** Remembers the break for this account; the next suggestion uses it. */
  async function chooseBreak(minutes: number) {
    const before = breakMinutes
    setBreakMinutes(minutes)
    try {
      await api.setPlanBreak(minutes)
    } catch (e) {
      setBreakMinutes(before)
      setError((e as Error).message)
    }
  }

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setStatus('idle')
    setSuggestion(null)
    setError(null)
    setRejected(new Set())
    setHovered(null)
    setRequests([])
    setDiff(null)
  }, [])

  // A plan only makes sense for the day it was made for.
  useEffect(() => reset, [date, reset])

  async function request(fromSlot: number, toSlot: number, includeBacklog = false) {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    paramsRef.current = { fromSlot, toSlot, includeBacklog }
    setStatus('loading')
    setError(null)
    try {
      const res = await api.aiSuggest(date, { fromSlot, toSlot, includeBacklog, breakMinutes }, controller.signal)
      setSuggestion(res)
      setRejected(new Set())
      setRequests([])
      setDiff(null)
      setStatus('ready')
    } catch (e) {
      if (controller.signal.aborted) return
      setError((e as Error).message)
      setStatus(suggestion ? 'ready' : 'idle')
    }
  }

  /** Asks the AI to change the suggestion on screen; blocks switched off stay off. */
  async function revise(message: string): Promise<boolean> {
    const text = message.trim()
    if (!suggestion || !text) return false
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setStatus('revising')
    setError(null)
    const before = suggestion.blocks
    const off = before.filter((b) => rejected.has(blockKey(b)))
    try {
      const { fromSlot, toSlot, includeBacklog } = paramsRef.current
      const revise = {
        previous: before.map((b) => ({ taskId: b.taskId, title: b.title, startSlot: b.startSlot, endSlot: b.endSlot, unchecked: rejected.has(blockKey(b)) })),
        earlier: requests,
        request: text,
      }
      const res = await api.aiSuggest(date, { fromSlot, toSlot, includeBacklog, breakMinutes: suggestion.breakMinutes, revise }, controller.signal)
      setSuggestion(res)
      setRejected(new Set(res.blocks.filter((b) => off.some((o) => o.taskId === b.taskId && o.title === b.title)).map(blockKey)))
      setRequests((r) => [...r, text])
      setDiff(diffSuggestion(before, res.blocks))
      setStatus('ready')
      return true
    } catch (e) {
      if (controller.signal.aborted) return false
      setError((e as Error).message)
      setStatus('ready')
      return false
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

  /** Saves the accepted blocks; returns what was saved, or null on failure. */
  async function apply(): Promise<AppliedPlan | null> {
    if (!suggestion || accepted.length === 0) return null
    setStatus('applying')
    setError(null)
    try {
      const acceptedTasks = new Set(accepted.map((b) => b.taskId))
      const estimates = suggestion.estimates.filter((e) => acceptedTasks.has(e.taskId))
      const applied = await api.aiApply(date, accepted, estimates)
      reset()
      return applied
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
    requests,
    diff,
    breakMinutes,
    chooseBreak,
    request,
    revise,
    cancel,
    toggle,
    apply,
    reset,
  }
}

export type AISuggestionState = ReturnType<typeof useAISuggestion>
