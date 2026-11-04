import { describe, expect, it } from 'vitest';
import { SWIPE_GAP_MS, SWIPE_THRESHOLD, SwipeTracker } from './swipeNav';

const always = () => true;

/** Feed a burst of equal events 16 ms apart; returns every step. */
function burst(tracker: SwipeTracker, n: number, dx: number, dy: number, start = 0, canStart = always) {
  return Array.from({ length: n }, (_, i) => tracker.feed(dx, dy, start + i * 16, canStart));
}

describe('SwipeTracker', () => {
  it('fires back once a leftward swipe crosses the threshold', () => {
    const steps = burst(new SwipeTracker(), 20, -20, 0);
    const fired = steps.filter((s) => s.fire !== 0);
    expect(fired).toEqual([{ dir: -1, progress: 1, fire: -1 }]);
  });

  it('fires forward for a rightward swipe', () => {
    const steps = burst(new SwipeTracker(), 20, 20, 1);
    expect(steps.find((s) => s.fire)?.fire).toBe(1);
  });

  it('reports growing progress before firing', () => {
    const steps = burst(new SwipeTracker(), 3, -30, 0);
    expect(steps.map((s) => s.progress)).toEqual([30 / SWIPE_THRESHOLD, 60 / SWIPE_THRESHOLD, 90 / SWIPE_THRESHOLD]);
  });

  it('never fires twice in one gesture (momentum after the swipe)', () => {
    const steps = burst(new SwipeTracker(), 60, -40, 0);
    expect(steps.filter((s) => s.fire).length).toBe(1);
  });

  it('fires again for a second gesture after a quiet gap', () => {
    const tracker = new SwipeTracker();
    const first = burst(tracker, 10, -40, 0);
    const second = burst(tracker, 10, -40, 0, 10 * 16 + SWIPE_GAP_MS + 1);
    expect([...first, ...second].filter((s) => s.fire).length).toBe(2);
  });

  it('leaves a vertical scroll alone even if it bends sideways later', () => {
    const tracker = new SwipeTracker();
    const steps = [...burst(tracker, 3, 0, 20), ...burst(tracker, 20, -40, 0, 48)];
    expect(steps.every((s) => s.dir === 0 && s.fire === 0)).toBe(true);
  });

  it('ignores the gesture when canStart refuses its direction', () => {
    const steps = burst(new SwipeTracker(), 20, -20, 0, 0, () => false);
    expect(steps.every((s) => s.dir === 0 && s.fire === 0)).toBe(true);
  });

  it('rewinds instead of flipping direction when the swipe reverses', () => {
    const tracker = new SwipeTracker();
    burst(tracker, 3, -30, 0);
    const back = burst(tracker, 10, 30, 0, 48);
    expect(back.every((s) => s.fire === 0 && s.dir === -1)).toBe(true);
    expect(back.at(-1)?.progress).toBe(0);
  });
});
