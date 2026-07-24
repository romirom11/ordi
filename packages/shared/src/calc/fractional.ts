/**
 * Fractional indexing (PRD §5.2): compute a position between two neighbours
 * without renumbering. We use numeric midpoints (NUMERIC column in DB).
 */

const STEP = 1000;

export function positionBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return STEP;
  if (before == null) return (after as number) - STEP;
  if (after == null) return (before as number) + STEP;
  return (before + after) / 2;
}

export function appendPosition(last: number | null): number {
  return last == null ? STEP : last + STEP;
}
