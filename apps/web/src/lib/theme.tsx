/**
 * Theme handling: system (default), light, or dark. The choice is stored in
 * localStorage and applied as data-theme on <html> before React paints
 * (applyStoredTheme is called from main.tsx at module load).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'dark' | 'light' | 'system';

const KEY = 'ordi:theme';

export function getStoredTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* private mode */ }
  return 'system';
}

function resolve(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function apply(pref: ThemePref) {
  document.documentElement.dataset.theme = resolve(pref);
}

export function applyStoredTheme(): void {
  apply(getStoredTheme());
}

interface ThemeCtx { pref: ThemePref; setPref: (p: ThemePref) => void; resolved: 'dark' | 'light' }
const Ctx = createContext<ThemeCtx>({ pref: 'system', setPref: () => {}, resolved: 'dark' });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(getStoredTheme);
  const [systemTheme, setSystemTheme] = useState(() => resolve('system'));

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    setSystemTheme(resolve('system'));
    try { localStorage.setItem(KEY, p); } catch { /* private mode */ }
    apply(p);
  };

  // Track OS changes while in system mode.
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = () => { setSystemTheme(resolve('system')); apply('system'); };
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  return <Ctx.Provider value={{ pref, setPref, resolved: pref === 'system' ? systemTheme : pref }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}
