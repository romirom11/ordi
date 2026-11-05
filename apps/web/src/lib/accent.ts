import type { CSSProperties } from 'react';

/**
 * CSS variables that recolour buttons, switches and focus rings inside one
 * subtree to a configured `#rrggbb` accent (the public intake form's). The
 * theme stores colours as bare HSL triples, so the hex is converted; the
 * label colour on the button follows the accent's luminance.
 */
export function accentVars(hex: string | null | undefined): CSSProperties | undefined {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
  if (!m) return undefined;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const hsl = (lightness: number) => `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(Math.max(0, Math.min(1, lightness)) * 100)}%`;
  // Relative luminance (WCAG): light accents get dark text.
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return {
    '--action': hsl(l),
    '--action-hover': hsl(l - 0.05),
    '--primary': hsl(l),
    '--ring': hsl(l),
    '--primary-foreground': luminance > 0.45 ? '220 20% 10%' : '0 0% 100%',
  } as CSSProperties;
}
