import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, getAuthToken, setAuthToken, setUnauthorizedHandler } from "./api";

export type User = { id: number; username: string; role: "admin" | "user" };

type AuthState = {
  user: User | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  expired: boolean;
  clearExpired: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

type LoginResponse = User & { token: string; expiresIn: number };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [expired, setExpired] = useState(false);

  const clearSession = useCallback(() => {
    setAuthToken(null);
    setUser(null);
  }, []);

  // Restore an in-memory/sessionStorage token by validating it against /api/me.
  useEffect(() => {
    let cancelled = false;
    setUnauthorizedHandler(() => {
      setUser(null);
      setExpired(true);
    });
    (async () => {
      if (!getAuthToken()) {
        if (!cancelled) setReady(true);
        return;
      }
      try {
        const me = await api<User>("/api/me", { raw: true });
        if (!cancelled) setUser(me);
      } catch (error) {
        if (!cancelled) {
          setAuthToken(null);
          if (error instanceof ApiError && error.status === 401) setExpired(false);
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      setUnauthorizedHandler(null);
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await api<LoginResponse>("/api/login", {
      method: "POST",
      body: { username, password },
      raw: true,
    });
    // Token is kept only in memory plus an optional sessionStorage mirror. Never logged.
    setAuthToken(result.token);
    setUser({ id: result.id, username: result.username, role: result.role });
    setExpired(false);
  }, []);

  const logout = useCallback(async () => {
    // Start revocation while the token is available, then clear locally immediately.
    const revoke = api("/api/logout", { method: "POST", raw: true });
    clearSession();
    try {
      await revoke;
    } catch {
      /* best effort - local session has already been cleared */
    }
  }, [clearSession]);

  const value = useMemo<AuthState>(
    () => ({ user, ready, login, logout, expired, clearExpired: () => setExpired(false) }),
    [user, ready, login, logout, expired],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}