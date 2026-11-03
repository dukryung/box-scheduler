import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, teamApi } from '../api/client'
import type { MeetingAudio } from '../api/types'
import { SPEECH_ERRORS, recognitionCtor, type Recognition } from './useSpeech'

// A recording is uploaded in pieces while the meeting goes on, so a closed tab
// loses at most the last piece. Pieces of one MediaRecorder recording, joined
// in order, are the whole file.
const PIECE_MS = 15000
const BITRATE = 32000 // speech stays clear; an hour is about 14 MB
const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
// After stopping, how long to keep trying to send what is left.
const FLUSH_MS = 60000

export type RecorderState = 'idle' | 'starting' | 'recording' | 'stopping'

export interface RecordingResult {
  /** The captions heard, one finished phrase per line. */
  lines: string[]
  audio: MeetingAudio | null
  /** Pieces that could not be sent (the recording on the server is cut short there). */
  lost: number
}

function pickType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
}

export const recordingSupported = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext
export const captionsSupported = () => recognitionCtor() !== undefined

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Records a meeting from the microphone, uploading it as it goes, with live
 * Korean captions from the browser's speech recognition (which keeps listening
 * for as long as the recording runs).
 */
export function useMeetingRecorder(teamId: string, meetingId: string) {
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [lines, setLines] = useState<string[]>([])
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [captionError, setCaptionError] = useState<string | null>(null)
  const [unsent, setUnsent] = useState(0)

  const media = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const speech = useRef<Recognition | null>(null)
  const recording = useRef(false)
  const startedAt = useRef(0)
  const audio = useRef<MeetingAudio | null>(null)
  const queue = useRef<{ seq: number; data: Blob }[]>([])
  const pumping = useRef<Promise<void> | null>(null)
  const giveUpAt = useRef(Infinity)
  const lost = useRef(0)
  const earlier = useRef<string[]>([]) // captions from speech sessions that ended
  const session = useRef<string[]>([]) // finished phrases of the current session, by result index
  const wakeLock = useRef<{ release(): Promise<void> } | null>(null)

  const publishLines = () => setLines([...earlier.current, ...session.current.filter(Boolean)])

  // Sends queued pieces in order, retrying with a growing pause until it works
  // (or, once stopped, until FLUSH_MS has passed).
  const pump = useCallback(() => {
    if (pumping.current) return pumping.current
    pumping.current = (async () => {
      let pause = 1000
      while (queue.current.length && audio.current) {
        const { seq, data } = queue.current[0]
        try {
          await teamApi.audioChunk(teamId, meetingId, audio.current.id, seq, data)
          queue.current.shift()
          pause = 1000
          setError(null)
        } catch (e) {
          const err = e as ApiError
          if (err.status === 409 || err.status === 413 || err.status === 404 || err.status === 403) {
            // Out of turn, closed or too big: this piece cannot be sent; keep the rest of the meeting going.
            queue.current.shift()
            lost.current++
            if (err.status !== 409) setError(err.message)
            continue
          }
          if (Date.now() > giveUpAt.current) {
            lost.current += queue.current.length
            queue.current = []
            break
          }
          setError('녹음을 서버로 보내지 못하고 있어요. 연결되면 이어서 보내요')
          await wait(pause)
          pause = Math.min(pause * 2, 15000)
        }
        setUnsent(queue.current.length)
      }
      setUnsent(queue.current.length)
      pumping.current = null
    })()
    return pumping.current
  }, [teamId, meetingId])

  const listen = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor || !recording.current) return
    const rec = new Ctor()
    rec.lang = 'ko-KR'
    rec.interimResults = true
    rec.continuous = true
    session.current = []
    rec.onresult = (e) => {
      let live = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const text = e.results[i][0].transcript.trim()
        if (e.results[i].isFinal) session.current[i] = text
        else live += `${text} `
      }
      setInterim(live.trim())
      publishLines()
    }
    rec.onerror = (e) => {
      // A pause in speech or a dropped connection ends the session; it is started again below.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') {
        setCaptionError(`${SPEECH_ERRORS[e.error] ?? '음성 인식에 실패했어요'}. 녹음은 계속돼요`)
        speech.current = null
      }
    }
    rec.onend = () => {
      earlier.current = [...earlier.current, ...session.current.filter(Boolean)]
      session.current = []
      setInterim('')
      publishLines()
      if (speech.current === rec && recording.current) setTimeout(listen, 250)
      else if (speech.current === rec) speech.current = null
    }
    speech.current = rec
    try {
      rec.start()
    } catch {
      setCaptionError('자막을 시작하지 못했어요. 녹음은 계속돼요')
    }
  }, [])

  const release = () => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
    void wakeLock.current?.release().catch(() => {})
    wakeLock.current = null
  }

  const start = useCallback(async () => {
    if (recording.current || state !== 'idle') return
    setError(null)
    setCaptionError(null)
    if (!recordingSupported()) {
      setError(window.isSecureContext ? '이 브라우저는 녹음을 지원하지 않아요' : '녹음은 https 주소나 localhost에서만 쓸 수 있어요')
      return
    }
    setState('starting')
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch {
      setError('마이크 권한을 허용해 주세요')
      setState('idle')
      return
    }
    const mimeType = pickType()
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream.current, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: BITRATE })
      audio.current = await teamApi.startAudio(teamId, meetingId, rec.mimeType || mimeType || 'audio/webm')
    } catch (e) {
      release()
      setError((e as Error).message)
      setState('idle')
      return
    }
    let seq = 0
    queue.current = []
    lost.current = 0
    giveUpAt.current = Infinity
    rec.ondataavailable = (e) => {
      if (!e.data.size) return
      queue.current.push({ seq: seq++, data: e.data })
      setUnsent(queue.current.length)
      void pump()
    }
    media.current = rec
    recording.current = true
    earlier.current = []
    session.current = []
    setLines([])
    setInterim('')
    startedAt.current = Date.now()
    setElapsed(0)
    rec.start(PIECE_MS)
    setState('recording')
    listen()
    try {
      wakeLock.current = await (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null
    } catch {
      // The screen may sleep; the recording goes on.
    }
  }, [state, teamId, meetingId, pump, listen])

  const stop = useCallback(async (): Promise<RecordingResult> => {
    const rec = media.current
    if (!rec || !recording.current) return { lines, audio: null, lost: 0 }
    setState('stopping')
    recording.current = false
    const stopped = new Promise<void>((r) => (rec.onstop = () => r()))
    rec.stop()
    const sp = speech.current
    const heard = sp ? new Promise<void>((r) => {
      const prev = sp.onend
      sp.onend = () => {
        prev?.()
        r()
      }
      setTimeout(r, 2000)
    }) : Promise.resolve()
    sp?.stop()
    await Promise.all([stopped, heard])
    release()
    media.current = null
    giveUpAt.current = Date.now() + FLUSH_MS
    await pump()
    let saved = audio.current
    if (saved) {
      try {
        saved = await teamApi.finishAudio(teamId, meetingId, saved.id, Math.round((Date.now() - startedAt.current) / 1000))
      } catch (e) {
        setError((e as Error).message)
      }
    }
    audio.current = null
    const result = { lines: [...earlier.current], audio: saved, lost: lost.current }
    setState('idle')
    return result
  }, [lines, pump, teamId, meetingId])

  useEffect(() => {
    if (state !== 'recording') return
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000)
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => {
      clearInterval(t)
      window.removeEventListener('beforeunload', warn)
    }
  }, [state])

  // Leaving the page mid-recording: keep what was recorded (the last piece is sent on stop).
  useEffect(
    () => () => {
      if (!recording.current) return
      recording.current = false
      giveUpAt.current = Date.now() + FLUSH_MS
      media.current?.stop()
      speech.current?.abort()
      release()
    },
    [],
  )

  return { state, elapsed, lines, interim, error, captionError, unsent, start, stop }
}
