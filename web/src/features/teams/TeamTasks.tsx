import { useCallback, useEffect, useMemo, useState } from 'react'
import { teamApi } from '../../api/client'
import type { TeamDetail, TeamTask, TeamTaskInput, TeamTaskStatus } from '../../api/types'
import { ConfirmInline } from '../../components/ConfirmInline'
import { Close, Plus } from '../../components/icons'
import { card, doneStrike, primaryButton, secondaryButton } from '../../components/styles'
import { todayISO } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { STATUS_LABEL, STATUS_TONE, STATUSES, periodText } from '../../lib/teamTasks'
import { useIsMobile } from '../../lib/useIsMobile'

const field = 'h-11 w-full rounded-[10px] border border-line-strong bg-surface px-3.5 text-[15px] text-ink outline-none focus:border-accent disabled:opacity-60 md:text-sm'
const VIEW_KEY = 'bs.teamTasks.view'

type Filter = 'all' | 'mine' | 'unassigned'

/** Hours as typed ("1.5") to 10-minute boxes; null when empty, NaN when not a valid amount. */
function hoursToBoxes(s: string): number | null {
  if (!s.trim()) return null
  const h = Number(s)
  if (!Number.isFinite(h) || h <= 0) return NaN
  return Math.max(1, Math.round(h * 6))
}
const boxesToHours = (b: number | null) => (b ? String(Math.round((b / 6) * 100) / 100) : '')
const personName = (a: { name: string; email: string }) => a.name || a.email.split('@')[0]

function readView(): 'list' | 'board' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'
  } catch {
    return 'list'
  }
}

function StatusPill({ status }: { status: TeamTaskStatus }) {
  return <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status]}`}>{STATUS_LABEL[status]}</span>
}

function Assignees({ task }: { task: TeamTask }) {
  if (!task.assignees.length) return <span className="text-xs text-muted">담당자 없음</span>
  return (
    <span className="flex flex-wrap gap-1">
      {task.assignees.map((a) => (
        <span key={a.userId} className="rounded-md bg-subtle px-1.5 py-0.5 text-[11px] text-ink-2">
          {personName(a)}
          {a.boxes ? ` ${formatDuration(a.boxes)}` : ''}
        </span>
      ))}
    </span>
  )
}

function Meta({ task, today }: { task: TeamTask; today: string }) {
  const period = periodText(task)
  const late = task.status !== 'done' && task.dueDate !== null && task.dueDate < today
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {period && <span className={`font-mono ${late ? 'font-semibold text-danger' : ''}`}>{late ? `${period} · 지남` : period}</span>}
      {task.estimateBoxes && <span className="font-mono">{formatDuration(task.estimateBoxes)}</span>}
    </span>
  )
}

/** The team's tasks: list or board, a filter, and the editor. */
export function TeamTasks({ team, meId }: { team: TeamDetail; meId: string }) {
  const mobile = useIsMobile()
  const today = todayISO()
  const [tasks, setTasks] = useState<TeamTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [status, setStatus] = useState<TeamTaskStatus | 'all'>('all')
  const [view, setViewState] = useState(readView)
  const [editing, setEditing] = useState<TeamTask | 'new' | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const shownView = mobile ? 'list' : view

  const load = useCallback(async () => {
    try {
      setTasks((await teamApi.tasks(team.id)).tasks)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [team.id])
  useEffect(() => {
    void load()
  }, [load])

  const setView = (v: 'list' | 'board') => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* the choice just isn't remembered */
    }
  }

  const shown = useMemo(
    () =>
      (tasks ?? []).filter(
        (t) => (filter === 'all' || (filter === 'mine' ? t.assignees.some((a) => a.userId === meId) : t.assignees.length === 0)) && (status === 'all' || shownView === 'board' || t.status === status),
      ),
    [tasks, filter, status, meId, shownView],
  )

  const setTaskStatus = async (t: TeamTask, next: TeamTaskStatus) => {
    if (t.status === next) return
    setError(null)
    setTasks((list) => list?.map((x) => (x.id === t.id ? { ...x, status: next } : x)) ?? null)
    try {
      const saved = await teamApi.updateTask(team.id, t.id, { status: next })
      setTasks((list) => list?.map((x) => (x.id === t.id ? saved : x)) ?? null)
    } catch (e) {
      setError((e as Error).message)
      void load()
    }
  }

  const statusControl = (t: TeamTask) =>
    t.canSetStatus ? (
      <select
        aria-label={`${t.title} 상태`}
        value={t.status}
        onChange={(e) => void setTaskStatus(t, e.target.value as TeamTaskStatus)}
        className={`h-7 shrink-0 rounded-md border-0 px-1.5 text-[11px] font-semibold ${STATUS_TONE[t.status]}`}
      >
        {STATUSES.map((s) => (
          <option key={s.key} value={s.key}>
            {s.label}
          </option>
        ))}
      </select>
    ) : (
      <StatusPill status={t.status} />
    )

  const chip = (on: boolean) => `rounded-full px-3 py-1.5 text-[13px] ${on ? 'bg-ink font-semibold text-surface' : 'bg-subtle text-ink-2 hover:text-ink'}`

  return (
    <section aria-label="팀 업무" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="업무 필터" className="flex gap-1.5">
          {(
            [
              ['all', '전체'],
              ['mine', '내 업무'],
              ['unassigned', '담당자 없음'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)} className={chip(filter === k)}>
              {label}
            </button>
          ))}
        </div>
        {shownView === 'list' && (
          <select
            aria-label="상태 필터"
            value={status}
            onChange={(e) => setStatus(e.target.value as TeamTaskStatus | 'all')}
            className="h-8 rounded-lg border border-line-strong bg-surface px-2 text-[13px]"
          >
            <option value="all">상태: 전체</option>
            {STATUSES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-2">
          {!mobile && (
            <div role="group" aria-label="보기 방식" className="flex rounded-[10px] bg-subtle p-[3px]">
              {(
                [
                  ['list', '목록'],
                  ['board', '보드'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  aria-pressed={view === k}
                  onClick={() => setView(k)}
                  className={`rounded-lg px-3 py-1 text-[13px] ${view === k ? 'bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(21,23,28,0.08)]' : 'text-muted hover:text-ink'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <button className={`${primaryButton} h-9`} onClick={() => setEditing('new')}>
            <Plus size={16} /> 업무
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}
      {tasks === null ? (
        <p className="p-4 text-sm text-muted">불러오는 중…</p>
      ) : tasks.length === 0 ? (
        <div className={`${card} flex flex-col items-center gap-2 px-4 py-10 text-center`}>
          <p className="text-[15px] font-semibold">아직 팀 업무가 없어요</p>
          <p className="text-sm text-muted">기간과 예상 시간, 담당자를 정해 팀이 함께 볼 업무를 만들어 보세요.</p>
          <button className={`${primaryButton} mt-2 h-10`} onClick={() => setEditing('new')}>
            <Plus size={16} /> 첫 업무 만들기
          </button>
        </div>
      ) : shownView === 'list' ? (
        <ul aria-label="업무 목록" className={`${card} flex flex-col divide-y divide-line`}>
          {shown.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted">조건에 맞는 업무가 없어요</li>}
          {shown.map((t) => (
            <li key={t.id} aria-label={t.title} className="flex flex-col gap-1.5 px-4 py-3 md:flex-row md:items-center md:gap-3">
              <button onClick={() => setEditing(t)} className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
                <span className={`text-[15px] font-medium md:text-sm ${t.status === 'done' ? `${doneStrike} text-muted` : ''}`}>{t.title}</span>
                <Meta task={t} today={today} />
              </button>
              <div className="flex items-center justify-between gap-3 md:justify-end">
                <Assignees task={t} />
                {statusControl(t)}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          {STATUSES.map((col) => {
            const items = shown.filter((t) => t.status === col.key)
            return (
              <section
                key={col.key}
                aria-label={`${col.label} ${items.length}`}
                onDragOver={(e) => dragId && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const t = tasks.find((x) => x.id === dragId)
                  setDragId(null)
                  if (t) void setTaskStatus(t, col.key)
                }}
                className="flex min-h-[200px] flex-col gap-2 rounded-2xl bg-subtle p-2.5"
              >
                <h3 className="flex items-center gap-2 px-1 text-[13px] font-semibold text-ink-2">
                  {col.label} <span className="font-mono text-muted">{items.length}</span>
                </h3>
                {items.map((t) => (
                  <article
                    key={t.id}
                    aria-label={t.title}
                    draggable={t.canSetStatus}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move'
                      setDragId(t.id)
                    }}
                    onDragEnd={() => setDragId(null)}
                    className={`${card} flex flex-col gap-2 p-3 ${t.canSetStatus ? 'cursor-grab active:cursor-grabbing' : ''} ${dragId === t.id ? 'opacity-50' : ''}`}
                  >
                    <button onClick={() => setEditing(t)} className="flex flex-col items-start gap-1 text-left">
                      <span className={`text-sm font-medium ${t.status === 'done' ? `${doneStrike} text-muted` : ''}`}>{t.title}</span>
                      <Meta task={t} today={today} />
                    </button>
                    <Assignees task={t} />
                  </article>
                ))}
              </section>
            )
          })}
        </div>
      )}

      {editing && (
        <TaskEditor
          team={team}
          meId={meId}
          task={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(t) => {
            setTasks((list) => (list?.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [...(list ?? []), t]))
            setEditing(null)
            void load()
          }}
          onDeleted={(id) => {
            setTasks((list) => list?.filter((x) => x.id !== id) ?? null)
            setEditing(null)
          }}
        />
      )}
    </section>
  )
}

interface EditorProps {
  team: TeamDetail
  meId: string
  task: TeamTask | null
  onClose: () => void
  onSaved: (t: TeamTask) => void
  onDeleted: (id: string) => void
}

/** Create or edit a team task. Those who may only move its status see the rest read-only. */
export function TaskEditor({ team, meId, task, onClose, onSaved, onDeleted }: EditorProps) {
  const isManager = team.role !== 'member'
  const editable = task ? task.canEdit : true
  const [title, setTitle] = useState(task?.title ?? '')
  const [note, setNote] = useState(task?.note ?? '')
  const [status, setStatus] = useState<TeamTaskStatus>(task?.status ?? 'todo')
  const [startDate, setStartDate] = useState(task?.startDate ?? '')
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '')
  const [estimate, setEstimate] = useState(boxesToHours(task?.estimateBoxes ?? null))
  // userId → hours as typed; present means assigned.
  const [assigned, setAssigned] = useState<Record<string, string>>(() => (task ? Object.fromEntries(task.assignees.map((a) => [a.userId, boxesToHours(a.boxes)])) : isManager ? {} : { [meId]: '' }))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const estimateBoxes = hoursToBoxes(estimate)
  const shares = Object.values(assigned).map(hoursToBoxes)
  const shareSum = shares.reduce<number>((s, b) => s + (b && !Number.isNaN(b) ? b : 0), 0)
  const canAssign = (userId: string) => editable && (isManager || userId === meId)

  const save = async () => {
    setError(null)
    if (!title.trim()) return setError('업무 제목을 적어 주세요')
    if (Number.isNaN(estimateBoxes) || shares.some((b) => Number.isNaN(b))) return setError('시간은 0보다 큰 숫자로 적어 주세요 (예: 1.5)')
    if (startDate && dueDate && startDate > dueDate) return setError('시작일이 마감일보다 늦어요')
    let body: TeamTaskInput
    if (!editable) body = { status }
    else
      body = {
        title: title.trim(),
        note,
        status,
        startDate,
        dueDate,
        estimateBoxes: estimateBoxes ?? 0,
        assignees: Object.entries(assigned).map(([userId, h]) => ({
          userId,
          boxes: hoursToBoxes(h),
        })),
      }
    setSaving(true)
    try {
      onSaved(task ? await teamApi.updateTask(team.id, task.id, body) : await teamApi.createTask(team.id, body))
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-[rgba(21,23,28,0.42)] md:items-center md:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        role="dialog"
        aria-label={task ? '업무 편집' : '새 업무'}
        className="flex max-h-dvh w-full flex-col overflow-hidden bg-surface md:max-h-[90dvh] md:max-w-xl md:rounded-2xl md:border md:border-line md:shadow-xl"
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3 md:px-5">
          <h2 className="flex-1 text-base font-semibold">{task ? (editable ? '업무 편집' : '업무 보기') : '새 업무'}</h2>
          <button onClick={onClose} aria-label="닫기" className="rounded-lg p-2 text-muted hover:bg-subtle">
            <Close size={18} />
          </button>
        </header>

        <form
          id="team-task-form"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 md:px-5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            제목
            <input autoFocus={!task} disabled={!editable} maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: API 문서화" className={field} />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
            설명
            <textarea
              disabled={!editable}
              rows={3}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-[10px] border border-line-strong bg-surface px-3.5 py-2.5 text-[15px] text-ink outline-none focus:border-accent disabled:opacity-60 md:text-sm"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
              시작일
              <input type="date" disabled={!editable} value={startDate} max={dueDate || undefined} onChange={(e) => setStartDate(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
              마감일
              <input type="date" disabled={!editable} value={dueDate} min={startDate || undefined} onChange={(e) => setDueDate(e.target.value)} className={field} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
              예상 시간 (시간)
              <input type="number" inputMode="decimal" min={0} step={0.5} disabled={!editable} value={estimate} onChange={(e) => setEstimate(e.target.value)} placeholder="예: 20" className={field} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-ink-2">
              상태
              <select disabled={!editable && !task?.canSetStatus} value={status} onChange={(e) => setStatus(e.target.value as TeamTaskStatus)} className={field}>
                {STATUSES.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1.5 text-sm font-medium text-ink-2">담당자와 맡은 시간</legend>
            {team.memberList.map((m) => {
              const on = m.userId in assigned
              const can = canAssign(m.userId)
              if (!on && !can) return null
              return (
                <div key={m.userId} className="flex items-center gap-3 py-1">
                  <label className={`flex min-w-0 flex-1 items-center gap-2.5 text-sm ${can ? '' : 'opacity-70'}`}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-accent"
                      checked={on}
                      disabled={!can}
                      onChange={(e) =>
                        setAssigned((cur) => {
                          const next = { ...cur }
                          if (e.target.checked) next[m.userId] = ''
                          else delete next[m.userId]
                          return next
                        })
                      }
                    />
                    <span className="truncate">
                      {personName(m)} {m.userId === meId && <span className="text-xs text-muted">(나)</span>}
                    </span>
                  </label>
                  {on && (
                    <input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.5}
                      aria-label={`${personName(m)} 맡은 시간`}
                      disabled={!can}
                      value={assigned[m.userId]}
                      onChange={(e) =>
                        setAssigned((cur) => ({
                          ...cur,
                          [m.userId]: e.target.value,
                        }))
                      }
                      placeholder="시간"
                      className="h-9 w-24 rounded-lg border border-line-strong bg-surface px-2.5 text-right text-sm disabled:opacity-60"
                    />
                  )}
                </div>
              )
            })}
            {editable && !isManager && <p className="text-xs text-muted">일반 멤버는 본인만 담당자로 지정할 수 있어요.</p>}
            {estimateBoxes && !Number.isNaN(estimateBoxes) && shareSum > 0 && shareSum !== estimateBoxes && (
              <p className="text-xs text-ink-2">
                맡은 시간 합계 {formatDuration(shareSum)} · 예상 시간 {formatDuration(estimateBoxes)}과 달라요
              </p>
            )}
          </fieldset>

          {task && (
            <p className="text-xs text-muted">
              {task.createdByName ? `${task.createdByName} 님이 만듦` : '만든 사람이 팀을 떠났어요'}
              {!editable && (task.canSetStatus ? ' · 담당자라서 상태만 바꿀 수 있어요' : ' · 보기만 할 수 있어요')}
            </p>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          {confirmDelete && task && (
            <ConfirmInline
              message="이 업무를 지울까요? 담당자 정보도 함께 지워져요."
              confirmLabel="지우기"
              onCancel={() => setConfirmDelete(false)}
              onConfirm={async () => {
                try {
                  await teamApi.deleteTask(team.id, task.id)
                  onDeleted(task.id)
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
            />
          )}
        </form>

        <footer className="flex items-center gap-2 border-t border-line px-4 py-3 pb-[max(env(safe-area-inset-bottom),12px)] md:px-5">
          {task && editable && !confirmDelete && (
            <button type="button" className="text-sm text-danger hover:underline" onClick={() => setConfirmDelete(true)}>
              삭제
            </button>
          )}
          <button type="button" className={`${secondaryButton} ml-auto h-10`} onClick={onClose}>
            취소
          </button>
          {(editable || task?.canSetStatus) && (
            <button type="submit" form="team-task-form" className={`${primaryButton} h-10`} disabled={saving}>
              {saving ? '저장 중…' : task ? '저장' : '만들기'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
