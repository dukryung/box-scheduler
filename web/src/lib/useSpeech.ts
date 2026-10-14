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

/**
 * Korean speech-to-text in the browser. `interim` updates while speaking;
 * `onFinal` gets the finished sentence once the person stops talking.
 */
export function useSpeech(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [error, setError] = useState<string | null>(null)
  const recRef = useRef<Recognition | null>(null)
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal
  const supported = recognitionCtor() !== undefined

  useEffect(() => () => recRef.current?.abort(), [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor || recRef.current) return
    const rec = new Ctor()
    rec.lang = 'ko-KR'
    rec.interimResults = true
    rec.continuous = false
    rec.onresult = (e) => {
      let text = ''
      let final = false
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript
        final ||= e.results[i].isFinal
      }
      setInterim(text)
      if (final && text.trim()) onFinalRef.current(text.trim())
    }
    rec.onerror = (e) => setError(ERRORS[e.error] ?? '음성 인식에 실패했어요')
    rec.onend = () => {
      recRef.current = null
      setListening(false)
      setInterim('')
    }
    recRef.current = rec
    setError(null)
    setInterim('')
    setListening(true)
    rec.start()
  }, [])

  const stop = useCallback(() => recRef.current?.stop(), [])

  return { supported, listening, interim, error, start, stop }
}
