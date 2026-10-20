import { nextThemePref, setThemePref, useThemePref } from '../lib/theme'
import { Monitor, Moon, Sun } from './icons'
import { iconButton } from './styles'

const LABEL = { system: '시스템 설정', light: '라이트', dark: '다크' } as const

/** Cycles 시스템 → 라이트 → 다크; the icon shows the current choice. */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const pref = useThemePref()
  const Icon = pref === 'light' ? Sun : pref === 'dark' ? Moon : Monitor
  const next = nextThemePref(pref)
  return (
    <button
      type="button"
      onClick={() => setThemePref(next)}
      aria-label={`화면 모드: ${LABEL[pref]} (눌러서 ${LABEL[next]}로 바꾸기)`}
      title={`화면 모드: ${LABEL[pref]}`}
      className={`${iconButton} ${className}`}
    >
      <Icon size={18} />
    </button>
  )
}
