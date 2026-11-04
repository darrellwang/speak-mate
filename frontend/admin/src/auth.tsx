import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { loginAdmin, logoutAdmin, onAuthLost, probeAdmin } from './api';

interface AuthState {
  ready: boolean;
  authed: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const stop = onAuthLost(() => setAuthed(false));
    probeAdmin()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false))
      .finally(() => setReady(true));
    return stop;
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      authed,
      async login(username: string, password: string) {
        const name = username.trim();
        if (name === '' || password === '') {
          throw new Error('请填写用户名和密码');
        }
        await loginAdmin(name, password);
        setAuthed(true);
      },
      async logout() {
        try {
          await logoutAdmin();
        } finally {
          setAuthed(false);
        }
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
