import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth';

const NAV = [
  { to: '/users', label: '用户' },
  { to: '/stats', label: '统计' },
  { to: '/system', label: '系统' },
  { to: '/security', label: '安全' },
] as const;

export function Shell({ children }: { children: ReactNode }) {
  const { logout } = useAuth();

  return (
    <div className="shell">
      <aside className="sider">
        <div className="brand">
          <span className="brand-mark">S</span>
          <div>
            <strong>SpeakMate</strong>
            <small>管理台</small>
          </div>
        </div>
        <nav className="nav" aria-label="管理台">
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button type="button" className="ghost logout" onClick={() => void logout()}>
          退出
        </button>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
