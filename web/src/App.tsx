import { BrowserRouter, Navigate, Route, Routes, useParams } from 'react-router'
import { DayView } from './features/day/DayView'
import { MonthView } from './features/month/MonthView'
import { StatsView } from './features/stats/StatsView'
import { TasksView } from './features/tasks/TasksView'
import { isValidISODate, isValidMonth, todayISO } from './lib/date'

function DayRoute() {
  const { date = '' } = useParams()
  return isValidISODate(date) ? <DayView date={date} /> : <Navigate to={`/day/${todayISO()}`} replace />
}

function MonthRoute() {
  const { month = '' } = useParams()
  return isValidMonth(month) ? <MonthView month={month} /> : <Navigate to={`/month/${todayISO().slice(0, 7)}`} replace />
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/day/:date" element={<DayRoute />} />
        <Route path="/month/:month" element={<MonthRoute />} />
        <Route path="/tasks" element={<TasksView />} />
        <Route path="/stats" element={<StatsView />} />
        <Route path="*" element={<Navigate to={`/day/${todayISO()}`} replace />} />
      </Routes>
    </BrowserRouter>
  )
}
