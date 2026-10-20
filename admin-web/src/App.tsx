import { useEffect } from 'react'
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router'
import { Admins } from './pages/Admins'
import { Audit } from './pages/Audit'
import { Dashboard } from './pages/Dashboard'
import { Layout } from './pages/Layout'
import { Login } from './pages/Login'
import { Me } from './pages/Me'
import { UserDetail } from './pages/UserDetail'
import { Users } from './pages/Users'
import { useSession } from './session'

/** Console pages need a finished sign-in (password changed, two-factor passed). */
function SignedIn() {
  const { account, stage } = useSession()
  const location = useLocation()
  if (account === undefined) return null
  if (!account || stage !== 'ok') return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />
  return <Outlet />
}

function SuperOnly() {
  const role = useSession((s) => s.account?.role)
  return role === 'super' ? <Outlet /> : <p className="text-sm text-muted">최고 관리자만 볼 수 있어요.</p>
}

export default function App() {
  const load = useSession((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<SignedIn />}>
          <Route element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="/users" element={<Users />} />
            <Route path="/users/:id" element={<UserDetail />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/me" element={<Me />} />
            <Route element={<SuperOnly />}>
              <Route path="/admins" element={<Admins />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
