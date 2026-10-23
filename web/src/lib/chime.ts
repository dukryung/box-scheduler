// A short chime when a notification pops up, made with Web Audio (no sound file).
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

/** Reminders ring two rising notes ("띵-동"); other notifications one, softer. */
export function chime(kind: 'reminder' | 'other', opts: { force?: boolean } = {}) {
  if (!opts.force && !soundOn()) return
  const a = audio()
  if (!a) return
  const play = () => {
    const notes = kind === 'reminder' ? [880, 1318.5] : [1046.5]
    const peak = kind === 'reminder' ? 0.2 : 0.12
    notes.forEach((freq, i) => {
      const t = a.currentTime + i * 0.15
      const osc = a.createOscillator()
      const gain = a.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5)
      osc.connect(gain).connect(a.destination)
      osc.start(t)
      osc.stop(t + 0.55)
    })
    window.dispatchEvent(new CustomEvent('bs:chime', { detail: kind }))
  }
  if (a.state === 'running') play()
  else if (opts.force) void a.resume().then(play)
}
