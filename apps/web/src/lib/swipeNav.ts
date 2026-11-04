/**
 * Two-finger trackpad swipe → back / forward, read from plain wheel events.
 *
 * The desktop app used to switch on the webview's own swipe gesture (WKWebView
 * allowsBackForwardNavigationGestures). That slides a snapshot of the WHOLE
 * window – sidebar included – and the snapshot of an SPA page is often
 * missing, so half the window turned black mid-swipe. It also walked the
 * webview's global history instead of the active tab's. Reading the gesture
 * here keeps the page still and steps the tab's own stack (TabsApi.go).
 *
 * A trackpad swipe arrives as a burst of wheel events with no begin / end
 * marker, so a quiet gap ends one gesture. The first few pixels decide whether
 * it is a horizontal swipe at all; a gesture that starts vertical stays a
 * scroll however it bends later, and one gesture fires at most once – the
 * momentum events that follow a swipe never trigger a second step.
 */

/** -1 back, +1 forward. Matches the delta TabsApi.go takes. */
export type SwipeDir = -1 | 1;

/** Horizontal travel (px of wheel delta) that commits a step. */
export const SWIPE_THRESHOLD = 150;
/** Quiet time between wheel events that ends a gesture. */
export const SWIPE_GAP_MS = 180;
/** Travel needed before the gesture's direction is decided. */
const DECIDE_PX = 10;
/** How clearly horizontal the opening travel must be. */
const HORIZONTAL_RATIO = 1.5;

export interface SwipeStep {
  /** Direction being tracked, 0 when the gesture is not a navigation swipe. */
  dir: SwipeDir | 0;
  /** 0…1 towards SWIPE_THRESHOLD, for the edge indicator. */
  progress: number;
  /** Set on the one event that crosses the threshold. */
  fire: SwipeDir | 0;
}

const NONE: SwipeStep = { dir: 0, progress: 0, fire: 0 };

type Phase = 'undecided' | 'tracking' | 'ignored' | 'done';

export class SwipeTracker {
  private phase: Phase = 'undecided';
  private dir: SwipeDir = -1;
  private dx = 0;
  private dy = 0;
  private last = -Infinity;

  /**
   * Feed one wheel event. `canStart` is asked once per gesture, when its
   * direction is known: false (nowhere to go, or the content under the
   * pointer scrolls that way) leaves the whole gesture to normal scrolling.
   */
  feed(dx: number, dy: number, time: number, canStart: (dir: SwipeDir) => boolean): SwipeStep {
    if (time - this.last > SWIPE_GAP_MS) this.reset();
    this.last = time;
    if (this.phase === 'ignored' || this.phase === 'done') return NONE;

    this.dx += dx;
    this.dy += dy;

    if (this.phase === 'undecided') {
      const ax = Math.abs(this.dx);
      const ay = Math.abs(this.dy);
      if (ax + ay < DECIDE_PX) return NONE;
      const dir: SwipeDir = this.dx < 0 ? -1 : 1;
      if (ax < ay * HORIZONTAL_RATIO || !canStart(dir)) {
        this.phase = 'ignored';
        return NONE;
      }
      this.phase = 'tracking';
      this.dir = dir;
    }

    // Swiping back the other way rewinds the indicator instead of flipping
    // the direction: a gesture means one thing.
    const progress = Math.min(Math.max((this.dx * this.dir) / SWIPE_THRESHOLD, 0), 1);
    if (progress >= 1) {
      this.phase = 'done';
      return { dir: this.dir, progress: 1, fire: this.dir };
    }
    return { dir: this.dir, progress, fire: 0 };
  }

  reset(): void {
    this.phase = 'undecided';
    this.dx = 0;
    this.dy = 0;
  }
}

/**
 * Whether anything between `target` and the page root can still scroll
 * horizontally towards `dir`. A kanban board or a wide table keeps the swipe
 * for itself until it reaches its edge, as in Safari.
 */
export function scrollsHorizontally(target: EventTarget | null, dir: SwipeDir): boolean {
  let el = target instanceof Element ? target : null;
  while (el && el !== document.documentElement) {
    if (el.scrollWidth > el.clientWidth + 1) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') {
        const atStart = el.scrollLeft <= 0;
        const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
        if (dir === -1 ? !atStart : !atEnd) return true;
      }
    }
    el = el.parentElement;
  }
  return false;
}
