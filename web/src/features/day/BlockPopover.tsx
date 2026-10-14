import { useEffect, useState } from 'react'
import type { Block } from '../../api/types'
import { formatRange, type SlotRange } from '../../lib/slots'
import { BLOCK_COLORS, DEFAULT_BLOCK_COLOR } from './colors'
import type { GridAnchor } from './TimeGrid'

const WIDTH = 288
const EST_HEIGHT = 230
const MARGIN = 8

type Props = {
  at: GridAnchor
  onClose: () => void
} & (
  | { mode: 'create'; range: SlotRange; onCreate: (title: string, color: string) => void }
  | {
      mode: 'edit'
      block: Block
      onSave: (patch: { title?: string; color?: string; done?: boolean }) => void
      onDelete: () => void
    }
)

export function BlockPopover(props: Props) {
  const { at, onClose } = props
  const editing = props.mode === 'edit' ? props.block : null
  const [title, setTitle] = useState(editing?.title ?? '')
  const [color, setColor] = useState(editing?.color ?? DEFAULT_BLOCK_COLOR)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const range = editing ? { start: editing.startSlot, end: editing.endSlot } : (props as { range: SlotRange }).range
  const left = Math.max(MARGIN, Math.min(at.x, window.innerWidth - WIDTH - MARGIN))
  const top = Math.max(MARGIN, Math.min(at.y + MARGIN, window.innerHeight - EST_HEIGHT - MARGIN))

  function submit() {
    const t = title.trim()
    if (props.mode === 'create') {
      if (t) props.onCreate(t, color)
    } else if (t && (t !== props.block.title || color !== props.block.color)) {
      props.onSave({ title: t, color })
    }
    onClose()
  }

  return (
    <>
      {/* Clicking outside saves (edit) or discards an empty draft (create). */}
      <div className="fixed inset-0 z-40" onPointerDown={submit} />
      <form
        className="fixed z-50 flex flex-col gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        style={{ left, top, width: WIDTH }}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="text-xs text-zinc-500 tabular-nums">{formatRange(range)}</div>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="무엇을 할까요?"
          className="rounded-md border border-zinc-300 bg-transparent px-2 py-1.5 text-sm outline-none focus:border-indigo-500 dark:border-zinc-600"
        />
        <div className="flex gap-1.5">
          {BLOCK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`색상 ${c}`}
              onClick={() => setColor(c)}
              className={`h-5 w-5 rounded-full ${c === color ? 'ring-2 ring-zinc-900 ring-offset-2 dark:ring-white dark:ring-offset-zinc-900' : ''}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>

        {editing && props.mode === 'edit' ? (
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={editing.done}
                onChange={(e) => props.onSave({ done: e.target.checked })}
              />
              완료
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  props.onDelete()
                  onClose()
                }}
                className="rounded-md px-3 py-1 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
              >
                삭제
              </button>
              <button type="submit" className="rounded-md bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-500">
                저장
              </button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              취소
            </button>
            <button
              type="submit"
              disabled={!title.trim()}
              className="rounded-md bg-indigo-600 px-3 py-1 text-sm text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              추가
            </button>
          </div>
        )}
      </form>
    </>
  )
}
