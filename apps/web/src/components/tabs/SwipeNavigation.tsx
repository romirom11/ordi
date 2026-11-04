/**
 * Desktop app only: a two-finger trackpad swipe steps the active tab back or
 * forward (lib/swipeNav). The page itself stays put; a small arrow slides in
 * from the window edge as the swipe builds up, so the gesture still has
 * feedback without the webview's page-slide snapshot.
 *
 * Browsers answer the swipe themselves (and the tab stack follows their
 * history), so this stays off outside the desktop app.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { isTauri } from '../../lib/desktop';
import { useTabs } from '../../lib/tabs';
import { SWIPE_GAP_MS, SwipeTracker, scrollsHorizontally, type SwipeDir } from '../../lib/swipeNav';

/** How far the arrow travels in from outside the window edge. */
const TRAVEL_PX = 72;
const SIZE_PX = 40;

export function SwipeNavigation() {
  const tabs = useTabs();
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const backRef = useRef<HTMLDivElement>(null);
  const forwardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauri) return;
    const tracker = new SwipeTracker();
    let endTimer: number | undefined;

    /** Place one arrow; progress 0 parks it outside the window. */
    const place = (dir: SwipeDir, progress: number, animate: boolean) => {
      const el = (dir === -1 ? backRef : forwardRef).current;
      if (!el) return;
      const offset = (progress * TRAVEL_PX - SIZE_PX) * (dir === -1 ? 1 : -1);
      el.style.transition = animate ? 'transform 200ms ease-out, opacity 200ms ease-out' : 'none';
      el.style.transform = `translate(${offset}px, -50%) scale(${progress >= 1 ? 1.1 : 1})`;
      el.style.opacity = String(progress);
      el.dataset.armed = progress >= 1 ? 'true' : 'false';
    };
    const hide = () => { place(-1, 0, true); place(1, 0, true); };

    const canStart = (target: EventTarget | null) => (dir: SwipeDir) => {
      const api = tabsRef.current;
      if (!api || !(dir === -1 ? api.canGoBack : api.canGoForward)) return false;
      // A swipe over an open dialog must not navigate the page behind it.
      if (target instanceof Element && target.closest('[role="dialog"], [aria-modal="true"]')) return false;
      return !scrollsHorizontally(target, dir);
    };

    const onWheel = (e: WheelEvent) => {
      // Pinch-zoom arrives as ctrl+wheel, Shift+wheel is a mouse's sideways
      // scroll, and a handler that claimed the event keeps it.
      if (e.ctrlKey || e.shiftKey || e.defaultPrevented) return;
      const step = tracker.feed(e.deltaX, e.deltaY, e.timeStamp, canStart(e.target));
      if (step.dir) place(step.dir, step.progress, false);
      if (step.fire) {
        tabsRef.current?.go(step.fire);
        // Let the arrow register as "done" for a beat, then retract.
        window.clearTimeout(endTimer);
        endTimer = window.setTimeout(hide, 120);
        return;
      }
      window.clearTimeout(endTimer);
      endTimer = window.setTimeout(hide, SWIPE_GAP_MS);
    };

    window.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.clearTimeout(endTimer);
    };
  }, []);

  if (!isTauri || !tabs) return null;

  const arrow = (dir: SwipeDir) => (
    <div
      ref={dir === -1 ? backRef : forwardRef}
      aria-hidden
      className="pointer-events-none fixed top-1/2 z-[60] grid place-items-center rounded-full border border-border bg-surface text-muted-foreground shadow-lg data-[armed=true]:border-transparent data-[armed=true]:bg-primary data-[armed=true]:text-primary-foreground"
      style={{
        width: SIZE_PX, height: SIZE_PX, opacity: 0,
        [dir === -1 ? 'left' : 'right']: 0,
        transform: `translate(${dir === -1 ? -SIZE_PX : SIZE_PX}px, -50%)`,
      }}
    >
      {dir === -1 ? <ArrowLeft size={18} /> : <ArrowRight size={18} />}
    </div>
  );

  return createPortal(<>{arrow(-1)}{arrow(1)}</>, document.body);
}
