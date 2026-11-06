import { useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router'
import { ProfileView, SettingsView } from './features/account/SettingsView'
import { LoginPage, ResetPage, SetupPage, SignupPage } from './features/auth/AuthPages'
import { DayView } from './features/day/DayView'
import { MonthView } from './features/month/MonthView'
import { StatsView } from './features/stats/StatsView'
import { TasksView } from './features/tasks/TasksView'
import { isValidISODate, isValidMonth, todayISO } from './lib/date'
import { Toaster } from './features/notify/Toaster'
import { useAuth } from './store/authStore'
import { InvitePage } from './features/teams/InvitePage'
import { NewTeamPage } from './features/teams/NewTeamPage'
import { TeamView } from './features/teams/TeamView'
import { WelcomePage } from './features/teams/WelcomePage'

function DayRoute() {
  const { date = '' } = useParams()
  return isValidISODate(date) ? <DayView date={date} /> : <Navigate to={`/day/${todayISO()}`} replace />
}

function MonthRoute() {
  const { month = '' } = useParams()
  return isValidMonth(month) ? <MonthView month={month} /> : <Navigate to={`/month/${todayISO().slice(0, 7)}`} replace />
}

/** Pages that need a signed-in account; others are sent to 로그인 and come back after. */
function SignedIn() {
  const user = useAuth((s) => s.user)
  const location = useLocation()
  if (user === undefined) return null
  if (user === null) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  // A new account chooses personal or team use first.
  if (!user.onboarded && location.pathname !== '/welcome') return <Navigate to="/welcome" replace />
  return (
    <>
      <Outlet />
      <Toaster />
    </>
  )
}

/** 로그인·가입 pages: an already signed-in person goes on to ?next, or today. */
function SignedOut() {
  const user = useAuth((s) => s.user)
  const location = useLocation()
  if (user === undefined) return null
  if (user) {
    // Signed in (or just signed up): go where the person was headed, e.g. back to an invite.
    const next = new URLSearchParams(location.search).get('next')
    const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : `/day/${todayISO()}`
    return <Navigate to={safe} replace />
  }
  return <Outlet />
}

export default function App() {
  const load = useAuth((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<SignedOut />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
        </Route>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/reset" element={<ResetPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route element={<SignedIn />}>
          <Route path="/day/:date" element={<DayRoute />} />
          <Route path="/month/:month" element={<MonthRoute />} />
          <Route path="/tasks" element={<TasksView />} />
          <Route path="/stats" element={<StatsView />} />
          <Route path="/profile" element={<ProfileView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/teams/new" element={<NewTeamPage />} />
          <Route path="/team/:teamId" element={<TeamView />} />
          <Route path="*" element={<Navigate to={`/day/${todayISO()}`} replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
