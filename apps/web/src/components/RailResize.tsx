/**
 * User-resizable width for the right-hand properties rails (task page, project
 * overview, CRM cards). A rail's default width is also its minimum – dragging
 * the left edge can only widen it, up to +50% – and the chosen width sticks
 * per rail kind via localStorage (`ordi:rail:<kind>`), the prefs.ts idiom.
 *
 * The width lands in a CSS variable rather than an inline `width` so each page
 * keeps its own responsive behaviour: above the page's breakpoint the rail (or
 * grid track) reads `var(--rail-w)`, below it the rail stacks full-width and
 * the variable is inert. Double-click on the handle resets to the default.
 */
import { useCallback, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { usePersistedState } from '../lib/prefs';
import { cn } from './ui';

export function useRailWidth(kind: 'task' | 'project' | 'crm', base: number) {
  const max = Math.round(base * 1.5);
  const clamp = useCallback(
    (n: number) => Math.min(max, Math.max(base, Math.round(n))),
    [base, max],
  );
  const [width, setWidth] = usePersistedState<number>(
    `ordi:rail:${kind}`,
    base,
    (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? clamp(raw) : base),
  );
  const onWidth = useCallback((n: number) => setWidth(clamp(n)), [setWidth, clamp]);
  return {
    width,
    base,
    onWidth,
    railStyle: { '--rail-w': `${width}px` } as CSSProperties,
  };
}

/**
 * The drag strip on the rail's left edge. The parent must be `relative`;
 * pass the page's breakpoint display class (e.g. `min-[1100px]:block`,
 * `lg:block`) – below it the rail is stacked and there is nothing to drag.
 */
export function RailResizeHandle({ width, base, onWidth, className }: {
  width: number;
  base: number;
  onWidth: (n: number) => void;
  className?: string;
}) {
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let frame = 0;
    const move = (ev: globalThis.PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => onWidth(startW + (startX - ev.clientX)));
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={() => onWidth(base)}
      className={cn(
        'absolute inset-y-0 left-0 z-10 hidden w-1 -translate-x-px cursor-col-resize transition-colors hover:bg-primary/40 active:bg-primary/50',
        className,
      )}
    />
  );
}
