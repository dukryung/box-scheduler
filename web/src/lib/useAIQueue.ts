import { useEffect, useState } from 'react'
import { aiApi } from '../api/client'

/** While an AI call is running, how many others wait for the service AI (polled every 2s). */
export function useAIQueue(active: boolean) {
  const [waiting, setWaiting] = useState(0)
  useEffect(() => {
    if (!active) {
      setWaiting(0)
      return
    }
    let stop = false
    const poll = async () => {
      const q = await aiApi.queue().catch(() => null)
      if (!stop && q) setWaiting(q.waiting)
    }
    const t = setInterval(poll, 2000)
    void poll()
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [active])
  return waiting
}
