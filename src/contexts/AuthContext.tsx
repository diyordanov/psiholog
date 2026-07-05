/**
 * AuthContext.tsx
 * Глобален React контекст за auth сесията.
 *
 * Компонентите използват `useAuth()` за достъп до текущата сесия и потребителя,
 * без да правят директни извиквания към Supabase. Това централизира auth логиката
 * и предотвратява дублирани subscription-и.
 *
 * Поток:
 *   1. При mount: `getSession()` зарежда съществуваща сесия (напр. от localStorage).
 *   2. `onAuthStateChange` слуша за промени (login, logout, token refresh) и
 *      обновява state-а в реално време.
 *   3. Докато сесията се зарежда, `loading = true` — AppContent показва spinner.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

interface AuthContextValue {
  session: Session | null;  // null = не е логнат или все още се зарежда
  user: User | null;        // удобен shortcut за session?.user
  loading: boolean;         // true докато getSession() не е приключил
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Обгражда цялото приложение и осигурява auth контекста на всички дъщерни компоненти. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Зареждаме съществуващата сесия при първоначален render.
    // Без това потребителят би видял login екрана при всяко презареждане.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    // Слушаме за промени в auth state-а (login, logout, token refresh).
    // Supabase автоматично обновява токена преди изтичане — listener-ът
    // актуализира state-а с новата сесия.
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    // Unsubscribe при unmount, за да няма memory leak.
    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Hook за достъп до auth контекста.
 * Хвърля грешка ако е използван извън <AuthProvider> — лесно за диагностика.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth() трябва да се ползва вътре в <AuthProvider>.');
  }
  return context;
}
