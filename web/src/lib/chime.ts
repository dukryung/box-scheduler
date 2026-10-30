// A chime of about two seconds when a notification pops up, made with Web Audio
// (no sound file), in a tone chosen in 설정 → 알림.
// Browsers only allow sound after the person has clicked or typed on the page,
// so the first such gesture unlocks it; until then the chime is skipped.

const KEY = 'bs.notify.sound'
let ctx: AudioContext | null = null

export function soundOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function setSoundOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* just not remembered */
  }
}

function audio(): AudioContext | null {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    ctx = new Ctor()
  }
  return ctx
}

/** Call from a click or key press so later chimes may play. */
export function unlockSound() {
  const a = audio()
  if (a?.state === 'suspended') void a.resume()
}

export type Tone = 'dingdong' | 'bell' | 'marimba' | 'digital'

export const TONES: Array<{ id: Tone; label: string }> = [
  { id: 'dingdong', label: '띵-동' },
  { id: 'bell', label: '종소리' },
  { id: 'marimba', label: '마림바' },
  { id: 'digital', label: '디지털 삐삐' },
]

const TONE_KEY = 'bs.notify.tone'

export function savedTone(): Tone {
  try {
    const t = localStorage.getItem(TONE_KEY)
    return TONES.some((x) => x.id === t) ? (t as Tone) : 'dingdong'
  } catch {
    return 'dingdong'
  }
}

export function setSavedTone(t: Tone) {
  try {
    localStorage.setItem(TONE_KEY, t)
  } catch {
    /* just not remembered */
  }
}

/** One note: a quick rise, then a fade over `len` seconds. */
function note(a: AudioContext, freq: number, at: number, len: number, peak: number, type: OscillatorType = 'sine') {
  const osc = a.createOscillator()
  const gain = a.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + len)
  osc.connect(gain).connect(a.destination)
  osc.start(at)
  osc.stop(at + len + 0.05)
}

// Each tone lasts about two seconds; v scales the loudness.
const play: Record<Tone, (a: AudioContext, t: number, v: number) => void> = {
  dingdong: (a, t, v) => {
    note(a, 880, t, 1.4, 0.2 * v)
    note(a, 1760, t, 0.6, 0.03 * v)
    note(a, 659.3, t + 0.45, 1.8, 0.2 * v)
    note(a, 1318.5, t + 0.45, 0.8, 0.03 * v)
  },
  bell: (a, t, v) => {
    // A bell's partials are not whole multiples, which gives it the ring.
    for (const [ratio, gain, len] of [
      [1, 0.18, 2.4],
      [2, 0.08, 1.8],
      [2.76, 0.06, 1.3],
      [5.4, 0.03, 0.7],
    ])
      note(a, 784 * ratio, t, len, gain * v)
  },
  marimba: (a, t, v) => {
    ;[523.3, 659.3, 784, 1046.5].forEach((f, i) => note(a, f, t + i * 0.22, i === 3 ? 1.3 : 0.7, 0.18 * v, 'triangle'))
  },
  digital: (a, t, v) => {
    for (let i = 0; i < 6; i++) note(a, 1000, t + i * 0.32 + (i % 2) * -0.16, 0.12, 0.05 * v, 'square')
  },
}

/** Reminders ring the chosen tone; other notifications ring it softer. */
export function chime(kind: 'reminder' | 'other', opts: { force?: boolean; tone?: Tone } = {}) {
  if (!opts.force && !soundOn()) return
  const a = audio()
  if (!a) return
  const ring = () => {
    play[opts.tone ?? savedTone()](a, a.currentTime, kind === 'reminder' ? 1 : 0.6)
    window.dispatchEvent(new CustomEvent('bs:chime', { detail: kind }))
  }
  if (a.state === 'running') ring()
  else if (opts.force) void a.resume().then(ring)
}
