// Authentication context. Fetches the current principal from /api/v1/me (populated by the
// backend's dev-auth or OIDC). RBAC in the UI is COSMETIC only — the API enforces every
// permission server-side; hasPermission just hides controls the user cannot use.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client';
import type { Principal } from '../api/types';

interface AuthState {
  principal: Principal | null;
  loading: boolean;
  /** 'unauthenticated' when the API returned 401; other errors are surfaced as-is. */
  error: string | null;
  unauthenticated: boolean;
  hasPermission: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unauthenticated, setUnauthenticated] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .me()
      .then((p) => {
        if (active) setPrincipal(p);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) setUnauthenticated(true);
        else setError(err instanceof Error ? err.message : 'Failed to load your identity.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const hasPermission = (permission: string): boolean => principal?.permissions.includes(permission) ?? false;

  return (
    <AuthContext.Provider value={{ principal, loading, error, unauthenticated, hasPermission }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
