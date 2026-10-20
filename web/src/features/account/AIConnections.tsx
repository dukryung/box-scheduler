import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { aiApi } from '../../api/client'
import type { AIConnection, AISettings, AIState } from '../../api/types'
import { ConfirmInline } from '../../components/ConfirmInline'
import { primaryButton, secondaryButton } from '../../components/styles'

const field = 'h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent md:text-sm'

const FEATURES: { key: keyof AISettings; label: string; hint: string }[] = [
  { key: 'plan', label: 'AI로 시간 정하기', hint: '여러 일을 하루에 나눠 배치해요. 큰 모델일수록 좋아요.' },
  { key: 'request', label: '말로 요청하기', hint: '요청을 일정 편집으로 바꿔요.' },
  { key: 'tidy', label: '음성 정리', hint: '받아 적은 말을 짧은 문장으로 다듬어요. 작은 모델도 충분해요.' },
]

const MODEL_LABEL: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5 (가장 똑똑함)',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 (균형)',
  'claude-haiku-5-5': 'Claude Haiku 5.5 (빠르고 저렴)',
}

const kindLabel = (c: AIConnection) => (c.kind === 'anthropic' ? 'Anthropic API' : '로컬 LLM')

function ConnectionRow({ c, onChanged }: { c: AIConnection; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; error: string } | null>(null)
  const [confirm, setConfirm] = useState(false)
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line p-3" aria-label={c.label}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">{c.label}</span>
        <span className="rounded-md bg-subtle px-1.5 py-0.5 text-[11px] font-semibold text-ink-2">{kindLabel(c)}</span>
        <span className="font-mono text-xs text-muted">{c.model}</span>
        {c.keyHint && <span className="font-mono text-xs text-muted">키 {c.keyHint}</span>}
      </div>
      {c.baseUrl && <span className="font-mono text-xs break-all text-muted">{c.baseUrl}</span>}
      {(result ? !result.ok : !!c.lastError) && (
        <p role="alert" className="text-xs text-danger">
          {result?.error || c.lastError}
        </p>
      )}
      {result?.ok && <p className="text-xs text-good">잘 연결돼요.</p>}
      <div className="flex gap-2">
        <button
          className={`${secondaryButton} h-9`}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setResult(await aiApi.test(c.id).catch((e: Error) => ({ ok: false, error: e.message })))
            setBusy(false)
          }}
        >
          {busy ? '확인하는 중…' : '연결 확인'}
        </button>
        <button className="h-9 rounded-xl px-3 text-sm text-danger hover:bg-danger/10" onClick={() => setConfirm(true)}>
          삭제
        </button>
      </div>
      {confirm && (
        <ConfirmInline
          message="이 연결과 저장된 키를 지울까요? 이 연결을 쓰던 기능은 AI 없음으로 바뀌어요."
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            await aiApi.remove(c.id)
            onChanged()
          }}
        />
      )}
    </li>
  )
}

function AddConnection({ state, onAdded }: { state: AIState; onAdded: () => void }) {
  const [kind, setKind] = useState<AIConnection['kind']>('anthropic')
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(state.anthropicModels[1] ?? '')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<'models' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const pick = (k: AIConnection['kind']) => {
    setKind(k)
    setError(null)
    setModel(k === 'anthropic' ? (state.anthropicModels[1] ?? '') : '')
  }

  const loadModels = async () => {
    setBusy('models')
    setError(null)
    try {
      const r = await aiApi.models(baseUrl, apiKey)
      setModels(r.models)
      if (r.models.length && !r.models.includes(model)) setModel(r.models[0])
      if (!r.models.length) setError('서버에 받아 둔 모델이 없어요. 예: ollama pull qwen3:14b')
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(null)
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setBusy('save')
    setError(null)
    try {
      await aiApi.connect({ kind, label, model, apiKey: apiKey || undefined, baseUrl: kind === 'openai' ? baseUrl : undefined })
      setApiKey('')
      setLabel('')
      onAdded()
    } catch (err) {
      setError((err as Error).message)
    }
    setBusy(null)
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3 rounded-xl border border-dashed border-line-strong p-3" aria-label="AI 연결 추가">
      <div role="radiogroup" aria-label="연결 종류" className="flex rounded-[10px] bg-subtle p-[3px]">
        {(
          [
            ['anthropic', 'Anthropic API 키'],
            ['openai', '로컬 LLM (Ollama·LM Studio)'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            onClick={() => pick(k)}
            className={`h-9 flex-1 rounded-lg text-[13px] ${kind === k ? 'bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(21,23,28,0.08)]' : 'text-muted'}`}
          >
            {l}
          </button>
        ))}
      </div>

      {kind === 'anthropic' ? (
        <>
          <p className="text-xs leading-relaxed text-muted">
            <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="font-semibold text-accent underline dark:text-accent-bright">
              console.anthropic.com
            </a>
            에서 만든 키를 넣으세요. 사용한 만큼 내 Anthropic 계정으로 청구돼요. 키는 암호화해서 저장하고 다시 보여 주지 않아요.
          </p>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            API 키
            <input type="password" autoComplete="off" required placeholder="sk-ant-…" className={field} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            모델
            <select className={field} value={model} onChange={(e) => setModel(e.target.value)}>
              {state.anthropicModels.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABEL[m] ?? m}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-muted">
            Mac mini 같은 컴퓨터에서 돌리는 Ollama(기본 :11434)나 LM Studio(기본 :1234)의 주소를 넣으세요. 집 안 네트워크 주소는 서버 관리자가 허용해야 연결돼요.
          </p>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            서버 주소
            <input type="url" required placeholder="http://mac-mini.local:11434" className={field} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            API 키 (있을 때만)
            <input type="password" autoComplete="off" className={field} value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </label>
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1.5 text-sm font-medium text-ink-2">
              모델
              {models && models.length > 0 ? (
                <select className={field} value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input required placeholder="예: qwen3:14b" className={field} value={model} onChange={(e) => setModel(e.target.value)} />
              )}
            </label>
            <button type="button" className={`${secondaryButton} h-11 shrink-0`} disabled={!baseUrl || busy !== null} onClick={() => void loadModels()}>
              {busy === 'models' ? '불러오는 중…' : '모델 불러오기'}
            </button>
          </div>
        </>
      )}
      <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
        이름 (선택)
        <input maxLength={40} placeholder={kind === 'anthropic' ? 'Anthropic API' : '집 Mac mini'} className={field} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      {error && (
        <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
      <button className={`${primaryButton} h-11`} disabled={busy !== null || !model}>
        {busy === 'save' ? '연결을 확인하는 중… (최대 1분)' : '확인하고 연결하기'}
      </button>
    </form>
  )
}

/** 설정 → AI 연결: the account's own AIs and which one each feature uses. */
export function AIConnections() {
  const [state, setState] = useState<AIState | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const s = await aiApi.state()
      setState(s)
      setAdding((a) => a || s.connections.length === 0)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  if (!state) return error ? <p className="text-sm text-danger">{error}</p> : null

  const options = [
    ...(state.serverAvailable ? [{ value: 'server', label: '서버 Claude 구독 (소유자)' }] : []),
    ...state.connections.map((c) => ({ value: c.id, label: `${c.label} · ${c.model}` })),
    { value: '', label: '사용 안 함' },
  ]
  const setFeature = async (key: keyof AISettings, value: string) => {
    const next = { ...state.settings, [key]: value }
    setState({ ...state, settings: next })
    setSaved(false)
    try {
      await aiApi.setSettings(next)
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!state.keysEnabled && <p className="text-sm text-danger">서버에 AI_SECRET_KEY가 설정되지 않아 API 키를 저장할 수 없어요.</p>}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-2">기능별로 쓸 AI</h3>
        {FEATURES.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <span className="flex flex-col sm:w-44">
              <span className="text-sm font-medium">{f.label}</span>
              <span className="text-[11px] text-muted">{f.hint}</span>
            </span>
            <select aria-label={`${f.label}에 쓸 AI`} className={`${field} sm:flex-1`} value={state.settings[f.key]} onChange={(e) => void setFeature(f.key, e.target.value)}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        {saved && (
          <p role="status" className="text-xs text-good">
            저장했어요.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink-2">내 AI 연결 {state.connections.length}</h3>
        {state.connections.length > 0 && (
          <ul className="flex flex-col gap-2">
            {state.connections.map((c) => (
              <ConnectionRow key={c.id} c={c} onChanged={() => void load()} />
            ))}
          </ul>
        )}
        {adding ? (
          <AddConnection
            state={state}
            onAdded={() => {
              setAdding(false)
              void load()
            }}
          />
        ) : (
          <button className={`${secondaryButton} h-11 self-start`} onClick={() => setAdding(true)}>
            + AI 연결 추가
          </button>
        )}
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  )
}
