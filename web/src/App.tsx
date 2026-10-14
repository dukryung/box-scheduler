import { useEffect, useState } from 'react'
import { api } from './api/client'
import type { Day } from './api/types'

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function App() {
  const [day, setDay] = useState<Day | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.getDay(todayISO()).then(setDay, (e: Error) => setError(e.message))
  }, [])

  return (
    <main style={{ padding: 24 }}>
      <h1>Box Scheduler</h1>
      {error && <p>API 오류: {error}</p>}
      {day && (
        <p>
          {day.date} ({WEEKDAYS[day.weekday]}) · 블록 {day.blocks.length}개 · Brain Dump {day.brainDump.length}개
        </p>
      )}
    </main>
  )
}
