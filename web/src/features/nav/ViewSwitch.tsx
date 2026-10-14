import { Link } from 'react-router'
import { monthOf } from '../../lib/date'

interface Props {
  view: 'day' | 'month'
  /** Day to open in day view, and whose month to open in month view. */
  date: string
}

export function ViewSwitch({ view, date }: Props) {
  const tab = (active: boolean) =>
    `rounded px-3 py-1 text-sm ${active ? 'bg-white shadow-sm dark:bg-zinc-700' : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'}`
  return (
    <nav aria-label="보기 전환" className="flex rounded-md bg-zinc-100 p-0.5 dark:bg-zinc-800">
      <Link to={`/day/${date}`} className={tab(view === 'day')} aria-current={view === 'day' ? 'page' : undefined}>
        일
      </Link>
      <Link to={`/month/${monthOf(date)}`} className={tab(view === 'month')} aria-current={view === 'month' ? 'page' : undefined}>
        월
      </Link>
    </nav>
  )
}
