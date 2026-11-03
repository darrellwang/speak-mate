import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Shell } from './components/Shell';
import { useAuth } from './auth';
import { LoginPage } from './pages/LoginPage';
import { SecurityPage } from './pages/SecurityPage';
import { StatsPage } from './pages/StatsPage';
import { SystemPage } from './pages/SystemPage';
import { UsersPage } from './pages/UsersPage';

function Boot() {
  return (
    <div className="boot">
      <p>正在核对管理员令牌…</p>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, authed } = useAuth();
  const location = useLocation();
  if (!ready) return <Boot />;
  if (!authed) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <Shell>{children}</Shell>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { ready, authed } = useAuth();
  if (!ready) return <Boot />;
  if (authed) return <Navigate to="/users" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        }
      />
      <Route
        path="/users"
        element={
          <RequireAuth>
            <UsersPage />
          </RequireAuth>
        }
      />
      <Route
        path="/stats"
        element={
          <RequireAuth>
            <StatsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/system"
        element={
          <RequireAuth>
            <SystemPage />
          </RequireAuth>
        }
      />
      <Route
        path="/security"
        element={
          <RequireAuth>
            <SecurityPage />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/users" replace />} />
    </Routes>
  );
}
