import { useCallback, useEffect, useRef, useState } from 'react'

// The Web Speech API is not in TypeScript's DOM types everywhere; this is the part we use.
interface RecognitionResult {
  readonly isFinal: boolean
  readonly 0: { readonly transcript: string }
}
interface RecognitionEvent {
  readonly resultIndex: number
  readonly results: ArrayLike<RecognitionResult>
}
interface Recognition {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: RecognitionEvent) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

const ERRORS: Record<string, string> = {
  'not-allowed': '마이크 권한을 허용해 주세요',
  'service-not-allowed': '마이크 권한을 허용해 주세요',
  'no-speech': '말소리가 들리지 않았어요',
  'audio-capture': '마이크를 찾지 못했어요',
}

// Dictation keeps listening through short pauses and stops after this much quiet.
const SILENCE_MS = 5000

/**
 * Korean dictation in the browser. `transcript` grows live while the person
 * talks; `onDone` gets the whole text when listening stops (mic tapped again,
 * or a few seconds of silence).
 */
export function useSpeech(onDone: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<Recognition | null>(null)
  const textRef = useRef('')
  const silenceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const supported = recognitionCtor() !== undefined

  useEffect(
    () => () => {
      if (silenceRef.current) clearTimeout(silenceRef.current)
      recRef.current?.abort()
    },
    [],
  )

  const stop = useCallback(() => recRef.current?.stop(), [])

  const armSilenceTimer = useCallback(() => {
    if (silenceRef.current) clearTimeout(silenceRef.current)
    silenceRef.current = setTimeout(() => recRef.current?.stop(), SILENCE_MS)
  }, [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor || recRef.current) return
    const rec = new Ctor()
    rec.lang = 'ko-KR'
    rec.interimResults = true
    rec.continuous = true
    rec.onresult = (e) => {
      // In continuous mode `results` holds everything said since start(): finished
      // phrases plus the one still being spoken.
      let text = ''
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript
      textRef.current = text
      setTranscript(text)
      armSilenceTimer()
    }
    rec.onerror = (e) => {
      if (e.error !== 'aborted') setError(ERRORS[e.error] ?? '음성 인식에 실패했어요')
    }
    rec.onend = () => {
      if (silenceRef.current) clearTimeout(silenceRef.current)
      recRef.current = null
      setListening(false)
      setTranscript('')
      const text = textRef.current.trim()
      textRef.current = ''
      if (text) onDoneRef.current(text)
    }
    recRef.current = rec
    textRef.current = ''
    setError(null)
    setTranscript('')
    setListening(true)
    armSilenceTimer()
    rec.start()
  }, [armSilenceTimer])

  return { supported, listening, transcript, error, start, stop }
}
