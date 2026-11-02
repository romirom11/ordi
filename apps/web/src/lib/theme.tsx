/**
 * Theme handling: dark (default), light, or system. The choice is stored in
 * localStorage and applied as data-theme on <html> before React paints
 * (applyStoredTheme is called from main.tsx at module load).
 *
 * The surface style is a second, independent axis: `classic` (solid panels)
 * or `glass` (translucent panels over an ambient backdrop). It works with
 * either colour theme and lands on <html> as data-style. A new installation
 * starts on Glass Dark; an explicitly stored choice always wins.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'dark' | 'light' | 'system';

export type StylePref = 'classic' | 'glass';

const KEY = 'ordi:theme';
const STYLE_KEY = 'ordi:style';

export function getStoredStyle(): StylePref {
  try {
    if (localStorage.getItem(STYLE_KEY) === 'classic') return 'classic';
  } catch { /* private mode */ }
  return 'glass';
}

function applyStyle(style: StylePref) {
  if (style === 'glass') document.documentElement.dataset.style = 'glass';
  else delete document.documentElement.dataset.style;
}

export function getStoredTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* private mode */ }
  return 'dark';
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
  applyStyle(getStoredStyle());
}

interface ThemeCtx {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  resolved: 'dark' | 'light';
  style: StylePref;
  setStyle: (s: StylePref) => void;
}
const Ctx = createContext<ThemeCtx>({ pref: 'dark', setPref: () => {}, resolved: 'dark', style: 'glass', setStyle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(getStoredTheme);
  const [systemTheme, setSystemTheme] = useState(() => resolve('system'));
  const [style, setStyleState] = useState<StylePref>(getStoredStyle);

  const setStyle = (next: StylePref) => {
    setStyleState(next);
    try { localStorage.setItem(STYLE_KEY, next); } catch { /* private mode */ }
    applyStyle(next);
  };

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

  return <Ctx.Provider value={{ pref, setPref, resolved: pref === 'system' ? systemTheme : pref, style, setStyle }}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  return useContext(Ctx);
}
