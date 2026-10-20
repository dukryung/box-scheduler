import { useCallback, useEffect, useState } from 'react'
import { api, type ServiceAIState } from '../api'
import { btn, dateTimeText, field } from '../format'
import { useSession } from '../session'
import { Badge, Card, ErrorText, PageHeader, Reauth, Stat } from '../ui'

const FEATURES = [
  ['planModel', 'AI로 시간 정하기', '여러 일을 하루에 배치 · 가장 어려운 일'],
  ['requestModel', '말로 요청하기', '요청을 일정 편집으로 바꿈'],
  ['tidyModel', '음성 정리', '받아 적은 말을 다듬음 · 작은 모델도 충분'],
] as const

type Form = {
  enabled: boolean
  baseUrl: string
  apiKey: string
  clearKey: boolean
  planModel: string
  requestModel: string
  tidyModel: string
  concurrency: number
  dailyLimit: number
}

/** The service's own AI (a local LLM such as Ollama on a Mac mini), used by every account by default. */
export function ServiceAI() {
  const isSuper = useSession((s) => s.account?.role === 'super')
  const [state, setState] = useState<ServiceAIState | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [testing, setTesting] = useState(false)

  const apply = useCallback((s: ServiceAIState) => {
    setState(s)
    const c = s.config
    setForm({ enabled: c.enabled, baseUrl: c.baseUrl, apiKey: '', clearKey: false, planModel: c.planModel, requestModel: c.requestModel, tidyModel: c.tidyModel, concurrency: c.concurrency, dailyLimit: c.dailyLimit })
  }, [])
  useEffect(() => {
    api.serviceAI().then(apply, (e: Error) => setError(e.message))
  }, [apply])

  if (!state || !form) return <ErrorText error={error} />
  const c = state.config
  const st = state.stats
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch })
  const modelOptions = Array.from(new Set([...models, form.planModel, form.requestModel, form.tidyModel].filter(Boolean)))

  return (
    <>
      <PageHeader title="서비스 AI">
        {c.enabled ? <Badge tone="good">켜짐</Badge> : <Badge tone="danger">꺼짐</Badge>}
      </PageHeader>
      <p className="text-sm text-muted">
        서비스가 가진 AI(예: Mac mini의 Ollama)를 모든 사용자가 기본으로 써요. 사용자는 따로 연결하지 않아도 되고, 하루 한도를 넘으면 자기 API 키를 연결해 계속 쓸 수 있어요.
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="24시간 호출" value={st.calls24h} />
        <Stat label="성공률" value={st.calls24h ? `${Math.round(st.successRate * 100)}%` : '–'} hint={`실패 ${st.failed24h} · 붐빔 ${st.busy24h}`} />
        <Stat label="평균 응답" value={st.avgMs24h ? `${(st.avgMs24h / 1000).toFixed(1)}초` : '–'} hint={`평균 대기 ${(st.avgWaitMs24h / 1000).toFixed(1)}초`} />
        <Stat label="오늘 쓴 사람" value={st.usersToday} />
        <Stat label="한도 다 쓴 사람" value={st.usersAtLimit} hint={`하루 ${c.dailyLimit || '무제한'}회`} />
        <Stat label="내 키·소유자 (24시간)" value={st.ownCalls24h + st.serverCalls24h} />
      </div>

      <Card
        title="상태"
        aside={
          <button
            className={btn.secondary}
            disabled={testing || !c.baseUrl}
            onClick={async () => {
              setTesting(true)
              const r = await api.testServiceAI().catch((e: Error) => ({ ok: false, error: e.message }))
              setNote(r.ok ? '잘 연결돼요.' : null)
              setError(r.ok ? null : r.error)
              setTesting(false)
              api.serviceAI().then(apply)
            }}
          >
            {testing ? '확인하는 중…' : '지금 연결 확인'}
          </button>
        }
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-4 text-sm md:grid-cols-4">
          {[
            ['서버', c.baseUrl || '–'],
            ['마지막 확인', dateTimeText(c.checkedAt)],
            ['마지막 오류', c.lastError || '없음'],
            ['마지막 변경', `${dateTimeText(c.updatedAt)} · ${c.updatedBy || '–'}`],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted">{k}</dt>
              <dd className={`break-all ${k === '마지막 오류' && c.lastError ? 'text-danger' : ''}`}>{v}</dd>
            </div>
          ))}
        </dl>
        <figure aria-label="최근 14일 서비스 AI 호출" className="flex h-16 items-end gap-1 border-t border-line px-4 pt-3 pb-2">
          {st.callsByDay.map((n, i) => (
            <div key={i} title={`${n}회`} className="flex h-full flex-1 items-end">
              <div className="w-full rounded-t-[3px] bg-accent-bright" style={{ height: n ? `${Math.max(6, (n / Math.max(...st.callsByDay)) * 100)}%` : 0 }} />
            </div>
          ))}
        </figure>
      </Card>
      {note && <p className="text-sm text-good">{note}</p>}
      <ErrorText error={error} />

      <Card title="설정">
        <form
          className="flex flex-col gap-4 px-4 py-4"
          onSubmit={(e) => {
            e.preventDefault()
            setConfirm(true)
          }}
        >
          <fieldset disabled={!isSuper} className="flex flex-col gap-4">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 accent-[var(--app-accent)]" />
              서비스 AI 켜기 (모든 사용자의 기본 AI)
            </label>
            <div className="grid gap-3 md:grid-cols-[2fr_1fr_auto] md:items-end">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                서버 주소 (OpenAI 호환)
                <input className={field} placeholder="http://192.168.0.23:11434" value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                API 키 {c.keyHint ? `(저장됨 ${c.keyHint})` : '(있을 때만)'}
                <input type="password" autoComplete="off" className={field} placeholder={c.keyHint ? '바꿀 때만 입력' : ''} value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
              </label>
              <button
                type="button"
                className={btn.secondary}
                disabled={!form.baseUrl}
                onClick={async () => {
                  setError(null)
                  try {
                    setModels((await api.serviceModels(form.baseUrl, form.apiKey)).models)
                  } catch (err) {
                    setError((err as Error).message)
                  }
                }}
              >
                모델 불러오기
              </button>
            </div>
            {c.keyHint && (
              <label className="flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={form.clearKey} onChange={(e) => set({ clearKey: e.target.checked })} /> 저장된 키 지우기
              </label>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              {FEATURES.map(([key, label, hint]) => (
                <label key={key} className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                  {label}
                  <select aria-label={`${label} 모델`} className={field} value={form[key]} onChange={(e) => set({ [key]: e.target.value })}>
                    <option value="">쓰지 않음</option>
                    {modelOptions.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] font-normal text-muted">{hint}</span>
                </label>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                동시 처리 수
                <input type="number" min={1} max={16} className={field} value={form.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })} />
                <span className="text-[11px] font-normal text-muted">M4 16GB에 8B 모델이면 1을 권해요. 넘치는 요청은 최대 2분, 20건까지 줄을 서요.</span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
                사용자별 하루 한도
                <input type="number" min={0} max={10000} className={field} value={form.dailyLimit} onChange={(e) => set({ dailyLimit: Number(e.target.value) })} />
                <span className="text-[11px] font-normal text-muted">세 기능을 합친 횟수예요. 0은 무제한. 소유자 계정은 한도가 없어요.</span>
              </label>
            </div>
          </fieldset>
          {isSuper ? (
            <button className={`${btn.primary} self-start`}>연결 확인하고 저장</button>
          ) : (
            <p className="text-sm text-muted">설정은 최고 관리자만 바꿀 수 있어요.</p>
          )}
        </form>
      </Card>

      <Card title="Mac mini 준비 (Ollama)">
        <ol className="flex list-decimal flex-col gap-1.5 py-4 pr-4 pl-9 text-sm text-ink-2">
          <li>
            Ollama 설치 후 모델 받기: <code className="font-mono">ollama pull qwen3:8b</code> (M4 16GB 권장, 약 5GB)
          </li>
          <li>
            다른 기기의 접속 허용: <code className="font-mono">launchctl setenv OLLAMA_HOST 0.0.0.0</code>, 메모리 아끼기:{' '}
            <code className="font-mono">launchctl setenv OLLAMA_NUM_PARALLEL 1</code>, 모델 유지: <code className="font-mono">launchctl setenv OLLAMA_KEEP_ALIVE 24h</code> — 그다음 Ollama 다시 시작
          </li>
          <li>Mac mini가 잠들지 않게: 시스템 설정 → 에너지 → 잠자기 방지</li>
          <li>
            위 서버 주소에 <code className="font-mono">http://Mac-mini-IP:11434</code>를 넣고 모델 불러오기 → 저장
          </li>
        </ol>
      </Card>

      {confirm && (
        <Reauth
          title="서비스 AI 저장"
          confirmLabel="저장"
          message={form.enabled ? '연결을 확인한 뒤 저장해요. 모든 사용자의 AI가 이 설정을 따라요. (최대 1분)' : '서비스 AI를 끄면 사용자들은 자기 API 키로만 AI를 쓸 수 있어요.'}
          onCancel={() => setConfirm(false)}
          onConfirm={async (password) => {
            const s = await api.saveServiceAI({ ...form, apiKey: form.apiKey || undefined, password })
            apply(s)
            setConfirm(false)
            setNote('저장했어요.')
            setError(null)
          }}
        />
      )}
    </>
  )
}
