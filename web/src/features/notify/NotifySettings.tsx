import { useEffect, useState } from 'react'
import { notifyApi } from '../../api/client'
import type { NotifySettings as Settings } from '../../api/types'
import { secondaryButton, primaryButton } from '../../components/styles'
import { chime, setSoundOn, soundOn } from '../../lib/chime'
import { browserTimezone, disablePush, enablePush, pushState, type PushState } from '../../lib/push'
import { useNotifications } from '../../store/notificationsStore'

/** 설정 → 알림: this browser's notifications, and which kinds to get. */
export function NotifySettings() {
  const { settings: saved, load } = useNotifications()
  // Shown at once while the change is saved.
  const [local, setLocal] = useState<Settings | null>(null)
  const settings = local ?? saved
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ text: string; tone: 'good' | 'danger' } | null>(null)
  const [sound, setSound] = useState(soundOn)

  useEffect(() => {
    void pushState().then(setState)
    if (!saved) void load()
  }, [saved, load])
  useEffect(() => {
    if (window.location.hash === '#notifications') document.getElementById('notifications')?.scrollIntoView()
  }, [])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setNote(null)
    try {
      await fn()
    } catch (e) {
      setNote({ text: (e as Error).message, tone: 'danger' })
    }
    setBusy(false)
  }

  const save = (patch: Partial<Settings>) => {
    if (!settings) return
    const next = { ...settings, ...patch, timezone: browserTimezone() }
    setLocal(next)
    return run(async () => {
      try {
        await notifyApi.settings(next)
        await load()
      } finally {
        setLocal(null)
      }
    })
  }

  const toggle = (key: 'reminders' | 'team', label: string, hint: string) => (
    <label className="flex items-start gap-3 text-sm">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-accent" checked={settings?.[key] ?? false} disabled={!settings} onChange={(e) => void save({ [key]: e.target.checked })} />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-xs text-muted">{hint}</span>
      </span>
    </label>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-xl bg-subtle px-4 py-3">
        <p className="text-sm font-medium">
          이 브라우저 알림:{' '}
          <span data-testid="push-state" className={state === 'on' ? 'text-good' : 'text-ink-2'}>
            {{ on: '켜짐', off: '꺼짐', denied: '차단됨', unsupported: '지원 안 함' }[state ?? 'off']}
          </span>
        </p>
        {state === 'denied' && <p className="text-xs text-muted">브라우저에서 이 사이트의 알림이 차단돼 있어요. 주소창 왼쪽의 사이트 설정에서 알림을 ‘허용’으로 바꾼 뒤 다시 눌러 주세요.</p>}
        {state === 'unsupported' && <p className="text-xs text-muted">이 브라우저는 알림을 지원하지 않아요. 앱 안의 🔔 알림함으로만 받아요.</p>}
        {state === 'off' && <p className="text-xs text-muted">켜 두면 앱 탭을 닫아도 브라우저가 실행 중이면 알림이 와요.</p>}
        <div className="flex flex-wrap gap-2">
          {state === 'off' && (
            <button className={`${primaryButton} h-10`} disabled={busy} onClick={() => void run(async () => setState(await enablePush()))}>
              이 브라우저에서 알림 받기
            </button>
          )}
          {state === 'on' && (
            <button className={`${secondaryButton} h-10`} disabled={busy} onClick={() => void run(async () => setState(await disablePush()))}>
              알림 끄기
            </button>
          )}
          <button
            className={`${secondaryButton} h-10`}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await notifyApi.test()
                await load()
                setNote({ text: state === 'on' ? '테스트 알림을 보냈어요. 잠시 후 화면 구석에 떠요.' : '테스트 알림을 🔔 알림함에 넣었어요.', tone: 'good' })
              })
            }
          >
            테스트 알림 보내기
          </button>
        </div>
      </div>
      {toggle('reminders', '일정 시작 10분 전 알림', '시간표에 넣은 일이 시작하기 10분 전에 알려 줘요. 완료한 일은 빼요.')}
      {toggle('team', '팀 알림', '누가 나를 팀 업무 담당자로 지정하거나, 내 몫을 AI로 세분화해 Brain Dump에 넣으면 알려 줘요.')}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="flex flex-1 items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-accent"
            checked={sound}
            onChange={(e) => {
              setSound(e.target.checked)
              setSoundOn(e.target.checked)
              if (e.target.checked) chime('reminder', { force: true })
            }}
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">알림 소리</span>
            <span className="text-xs text-muted">앱 화면에 알림이 뜰 때 짧게 ‘띵-동’ 울려요. 이 브라우저에만 적용돼요.</span>
          </span>
        </label>
        <button className={`${secondaryButton} h-9 text-xs`} onClick={() => chime('reminder', { force: true })}>
          소리 들어보기
        </button>
      </div>
      {note && (
        <p role={note.tone === 'danger' ? 'alert' : 'status'} className={`text-sm ${note.tone === 'danger' ? 'text-danger' : 'text-good'}`}>
          {note.text}
        </p>
      )}
    </div>
  )
}
