interface Props {
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

/** A small in-place "are you sure?" row for destructive actions. */
export function ConfirmInline({ message, confirmLabel = '삭제', onConfirm, onCancel }: Props) {
  return (
    <div role="alertdialog" aria-label="삭제 확인" className="flex flex-wrap items-center gap-2 rounded-lg bg-danger/5 px-3 py-2 text-xs text-ink-2">
      <span className="flex-1">{message}</span>
      <button onClick={onCancel} className="rounded-md px-2 py-1 hover:bg-subtle">
        취소
      </button>
      <button onClick={onConfirm} className="rounded-md bg-danger px-2.5 py-1 font-semibold text-white">
        {confirmLabel}
      </button>
    </div>
  )
}
