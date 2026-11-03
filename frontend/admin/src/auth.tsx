import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { clearAdminToken, hasAdminToken, onAuthLost, probeAdmin, setAdminToken } from './api';

interface AuthState {
  ready: boolean;
  authed: boolean;
  login: (token: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const stop = onAuthLost(() => setAuthed(false));
    if (!hasAdminToken()) {
      setReady(true);
      return stop;
    }
    probeAdmin()
      .then(() => setAuthed(true))
      .catch(() => {
        clearAdminToken();
        setAuthed(false);
      })
      .finally(() => setReady(true));
    return stop;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      authed,
      async login(token: string) {
        const trimmed = token.trim();
        if (trimmed === '') {
          throw new Error('请填写管理员访问令牌');
        }
        await probeAdmin(trimmed);
        setAdminToken(trimmed);
        setAuthed(true);
      },
      logout() {
        clearAdminToken();
        setAuthed(false);
      },
    }),
    [authed, ready],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('AuthProvider 缺失');
  }
  return value;
}
