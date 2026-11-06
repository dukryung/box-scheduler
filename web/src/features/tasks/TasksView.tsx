import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { BacklogItem } from '../../api/types'
import { ConfirmInline } from '../../components/ConfirmInline'
import { ArrowRight, Close, Plus, Sparkle } from '../../components/icons'
import { card, doneText, srOnly } from '../../components/styles'
import { GROUP_LABELS, deadlineCounts, groupBacklog } from '../../lib/backlog'
import { todayISO } from '../../lib/date'
import { formatDuration } from '../../lib/slots'
import { useTasksStore } from '../../store/tasksStore'
import { BottomTabs, TopBar, ViewSwitch } from '../nav/ViewSwitch'
import { DueBadge, PriorityBadge, Progress } from './parts'
import { BreakdownDialog } from './BreakdownDialog'

export function TasksView() {
  const { items, loaded, error, load, add, remove, setError } = useTasksStore()
  const [clearing, setClearing] = useState(false)
  const [text, setText] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  // Which row's editor is open; kept here so it survives the row moving to another group.
  const [expanded, setExpanded] = useState<string | null>(null)
  const today = todayISO()

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!error && !notice) return
    const id = setTimeout(() => {
      setError(null)
      setNotice(null)
    }, 4000)
    return () => clearTimeout(id)
  }, [error, notice, setError])

  const groups = groupBacklog(items, today)
  const counts = deadlineCounts(items, today)
  const open = items.filter((it) => it.status === 'open').length

  return (
    <div className="flex min-h-dvh flex-col bg-ground text-ink">
      <TopBar phoneTheme>
        <h1 className="flex flex-1 items-center justify-center gap-2 text-[17px] font-semibold md:flex-none md:justify-start md:pl-2 md:text-lg">
          할 일 보관함
          <span className="rounded-full bg-subtle px-2 text-xs font-semibold text-ink-2" aria-label={`남은 일 ${open}개`}>
            {open}
          </span>
        </h1>
        <div className="ml-auto hidden md:block">
          <ViewSwitch view="tasks" date={today} />
        </div>
      </TopBar>

      <main className="mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 pt-3 pb-[104px] md:px-6 md:pt-5 md:pb-10">
        <section className={`${card} flex flex-col gap-2 p-4`}>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              void add(text)
              setText('')
            }}
          >
            <label htmlFor="task-input" className={srOnly}>
              보관함에 할 일 추가
            </label>
            <input
              id="task-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="예: 계약서 검토 1시간 ~10/30 !"
              className="h-12 min-w-0 flex-1 rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] outline-none focus:border-accent md:h-11 md:text-sm"
            />
            <button
              type="submit"
              aria-label="추가"
              disabled={!text.trim()}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent text-white disabled:opacity-40 md:h-11 md:w-11"
            >
              <Plus size={18} />
            </button>
          </form>
          <p className="text-xs leading-relaxed text-muted">
            날짜를 정하지 않은 일을 모아 두세요. 끝에 ‘1시간’(예상 시간), ‘~10/30’·‘~내일’(마감일), ‘!’(중요)를 붙일 수 있어요.
          </p>
        </section>

        {counts.soon > 0 && (
          <p className="px-1 text-sm font-semibold text-ink-2" role="status">
            오늘·내일 마감 {counts.soon}개
          </p>
        )}

        {loaded && items.length === 0 && (
          <p className="rounded-2xl border border-dashed border-line-strong px-4 py-12 text-center text-sm leading-relaxed text-muted">
            아직 보관함이 비어 있어요.
            <br />
            언젠가 꼭 해야 하는 일을 적어 두면, 시간이 날 때 시간표에 넣을 수 있어요.
          </p>
        )}

        {groups.map(({ key, items: list }) =>
          key === 'done' ? (
            <details key={key} className="group">
              <summary className="cursor-pointer px-1 py-1 text-sm font-semibold text-muted">
                {GROUP_LABELS[key]} {list.length}
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                {clearing ? (
                  <ConfirmInline
                    message={`완료한 일 ${list.length}개를 보관함에서 모두 지울까요?${
                      list.some((it) => it.blockCount > 0) ? ' 시간표에 남은 블록도 함께 지워져요.' : ''
                    }`}
                    confirmLabel="모두 지우기"
                    onConfirm={() => {
                      setClearing(false)
                      for (const it of list) void remove(it.id)
                    }}
                    onCancel={() => setClearing(false)}
                  />
                ) : (
                  <button onClick={() => setClearing(true)} className="self-end rounded-md px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10">
                    완료한 일 모두 지우기
                  </button>
                )}
              </div>
              <ul className="mt-2 flex flex-col gap-2">
                {list.map((it) => (
                  <TaskRow
                    key={it.id}
                    item={it}
                    today={today}
                    open={expanded === it.id}
                    onToggle={() => setExpanded((id) => (id === it.id ? null : it.id))}
                    onMoved={setNotice}
                  />
                ))}
              </ul>
            </details>
          ) : (
            <section key={key} aria-label={GROUP_LABELS[key]} className="flex flex-col gap-2">
              <h2 className={`px-1 text-sm font-semibold ${key === 'overdue' ? 'text-danger' : 'text-ink-2'}`}>
                {GROUP_LABELS[key]} <span className="font-normal text-muted">{list.length}</span>
              </h2>
              <ul className="flex flex-col gap-2">
                {list.map((it) => (
                  <TaskRow
                    key={it.id}
                    item={it}
                    today={today}
                    open={expanded === it.id}
                    onToggle={() => setExpanded((id) => (id === it.id ? null : it.id))}
                    onMoved={setNotice}
                  />
                ))}
              </ul>
            </section>
          ),
        )}
      </main>

      {(error ?? notice) && (
        <div
          role={error ? 'alert' : 'status'}
          className="fixed bottom-24 left-1/2 z-50 flex max-w-[calc(100vw-32px)] -translate-x-1/2 items-center gap-3 rounded-xl bg-ink px-4 py-2.5 text-sm text-surface shadow-lg md:bottom-6"
        >
          {error ?? notice}
          {!error && (
            <Link to={`/day/${today}`} className="font-semibold text-accent-soft">
              보러 가기
            </Link>
          )}
        </div>
      )}

      <BottomTabs view="tasks" date={today} />
    </div>
  )
}

interface RowProps {
  item: BacklogItem
  today: string
  open: boolean
  onToggle: () => void
  onMoved: (msg: string) => void
}

function TaskRow({ item, today, open, onToggle, onMoved }: RowProps) {
  const { update, remove, moveToDay, load } = useTasksStore()
  const [confirming, setConfirming] = useState(false)
  const [splitting, setSplitting] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const done = item.status === 'done'
  const estimate = item.estimateBoxes
  const stepper = 'flex h-7 w-7 items-center justify-center rounded-md text-ink-2 hover:bg-line disabled:opacity-30'

  const commitTitle = (value: string) => {
    setEditingTitle(false)
    const t = value.trim()
    if (t && t !== item.title) void update(item.id, { title: t })
  }

  return (
    <li className={`${card} flex flex-col gap-3 p-3.5 ${done ? 'border-transparent! bg-done-soft!' : ''}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className={`mt-0.5 h-5 w-5 shrink-0 ${done ? 'done-pop accent-[var(--app-done)]' : 'accent-[var(--app-accent)]'}`}
          aria-label={`${item.title} 완료`}
          checked={done}
          onChange={(e) => void update(item.id, { status: e.target.checked ? 'done' : 'open' })}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {editingTitle ? (
            <input
              autoFocus
              defaultValue={item.title}
              aria-label="할 일 이름"
              onBlur={(e) => commitTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle(e.currentTarget.value)
                if (e.key === 'Escape') setEditingTitle(false)
              }}
              className="rounded-md border border-accent bg-transparent px-1.5 text-[15px] outline-none"
            />
          ) : (
            <span
              onDoubleClick={() => !done && setEditingTitle(true)}
              className={`text-[15px] leading-snug font-medium break-words ${done ? doneText : ''}`}
            >
              {item.title}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
            <PriorityBadge priority={item.priority} />
            {item.dueDate && !done && <DueBadge due={item.dueDate} today={today} />}
            {!done && (
              <span className="flex items-center rounded-md bg-subtle">
                <button
                  aria-label="예상 시간 줄이기"
                  disabled={!estimate || estimate <= 1}
                  onClick={() => estimate && void update(item.id, { estimateBoxes: estimate - 1 })}
                  className={stepper}
                >
                  −
                </button>
                <span className="px-0.5 font-mono text-ink-2">{estimate ? formatDuration(estimate) : '시간 미정'}</span>
                <button
                  aria-label="예상 시간 늘리기"
                  disabled={(estimate ?? 0) >= 144}
                  onClick={() => void update(item.id, { estimateBoxes: (estimate ?? 0) + 1 })}
                  className={stepper}
                >
                  +
                </button>
              </span>
            )}
            <Progress item={item} />
            {item.pieces > 0 && (
              <span className="rounded-md bg-ai-soft px-1.5 py-0.5 text-[11px] font-semibold text-ai-ink">
                세분화 {item.pieces}개{item.piecesDone > 0 ? ` · 완료 ${item.piecesDone}` : ''}
              </span>
            )}
            {!done && (
              <button
                onClick={() => setSplitting(true)}
                className="flex h-7 items-center gap-1 rounded-md border border-ai-line px-2 text-[11px] font-semibold text-ai-ink hover:bg-ai-soft"
              >
                <Sparkle size={12} /> {item.pieces > 0 ? '다시 세분화' : 'AI로 세분화'}
              </button>
            )}
            {item.note && !open && <span className="max-w-full truncate text-faint">메모: {item.note}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!done && (
            <button
              onClick={async () => {
                if (await moveToDay(item.id, today)) onMoved(`‘${item.title}’을(를) 오늘 Brain Dump로 옮겼어요`)
              }}
              aria-label="오늘 하기"
              className="flex h-9 items-center gap-1 rounded-[10px] border border-line-strong px-2.5 text-[13px] font-semibold hover:bg-subtle sm:px-3"
            >
              <span className="sm:hidden">오늘</span>
              <span className="hidden sm:inline">오늘 하기</span>
              <ArrowRight size={14} />
            </button>
          )}
          <button
            onClick={onToggle}
            aria-expanded={open}
            className="h-9 rounded-[10px] px-2.5 text-[13px] text-ink-2 hover:bg-subtle"
          >
            {open ? '접기' : '편집'}
          </button>
          <button
            aria-label={`${item.title} 삭제`}
            onClick={() => (item.blockCount > 0 ? setConfirming(true) : void remove(item.id))}
            className="rounded-md p-1.5 text-faint hover:text-danger"
          >
            <Close size={14} />
          </button>
        </div>
      </div>

      {splitting && (
        <BreakdownDialog
          item={item}
          today={today}
          onClose={() => setSplitting(false)}
          onApplied={(message) => {
            setSplitting(false)
            onMoved(message)
            void load()
          }}
        />
      )}
      {confirming && (
        <ConfirmInline
          message={`시간표의 블록 ${item.blockCount}개도 함께 지워져요.`}
          onConfirm={() => void remove(item.id)}
          onCancel={() => setConfirming(false)}
        />
      )}

      {open && (
        <div className="flex flex-col gap-3 border-t border-grid pt-3 sm:pl-8">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted">
              마감일
              <input
                type="date"
                value={item.dueDate ?? ''}
                onChange={(e) => void update(item.id, { dueDate: e.target.value })}
                className="h-10 rounded-[10px] border border-line-strong bg-surface px-2.5 font-mono text-sm text-ink"
              />
            </label>
            {item.dueDate && (
              <button onClick={() => void update(item.id, { dueDate: '' })} className="h-10 rounded-[10px] px-2.5 text-[13px] text-ink-2 hover:bg-subtle">
                마감 지우기
              </button>
            )}
            <div className="flex flex-col gap-1 text-xs text-muted">
              중요도
              <div role="radiogroup" aria-label="중요도" className="flex rounded-[10px] bg-subtle p-[3px]">
                {(
                  [
                    [1, '높음'],
                    [2, '보통'],
                    [3, '낮음'],
                  ] as const
                ).map(([p, label]) => (
                  <button
                    key={p}
                    role="radio"
                    aria-checked={(item.priority ?? 2) === p}
                    onClick={() => void update(item.id, { priority: p })}
                    className={`h-8 rounded-lg px-3 text-[13px] ${(item.priority ?? 2) === p ? 'bg-surface font-semibold text-ink shadow-sm' : 'text-muted'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted">
            메모
            <textarea
              defaultValue={item.note ?? ''}
              rows={2}
              placeholder="필요한 자료, 연락처 등"
              onBlur={(e) => e.target.value !== (item.note ?? '') && void update(item.id, { note: e.target.value })}
              className="rounded-[10px] border border-line-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent"
            />
          </label>
        </div>
      )}
    </li>
  )
}
