import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { getToken, setUnauthorizedHandler } from '@/api/http'
import { BotsPage } from '@/pages/BotsPage'
import { LoginPage } from '@/pages/LoginPage'
import { FlowEditorPage } from '@/flow/FlowEditorPage'
import { CodeEditorPage } from '@/code/CodeEditorPage'
import { AppShell } from './AppShell'

export function App() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }))
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/studio">
        <SessionGuard onLogout={() => queryClient.clear()} />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/" element={<BotsPage />} />
            <Route path="/bots/:botId/flows" element={<FlowEditorPage />} />
            <Route path="/bots/:botId/code" element={<CodeEditorPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

/** A 401 from any request ends the session and returns to the login page. */
function SessionGuard({ onLogout }: { onLogout: () => void }) {
  const navigate = useNavigate()
  useEffect(() => {
    setUnauthorizedHandler(() => {
      onLogout()
      navigate('/login', { replace: true })
    })
    return () => setUnauthorizedHandler(null)
  }, [navigate, onLogout])
  return null
}

function RequireAuth() {
  const location = useLocation()
  if (!getToken()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <AppShell />
}
