/**
 * The one rule a date field applies, whichever way the date arrived.
 *
 * A DateField can be filled four ways – typing, picking a day in the grid,
 * the Today button and Clear – and each used to check something different:
 * the grid honoured min/max, typing and Today did not, and unparseable text
 * silently reverted. Every route now asks this module, so a bound or a
 * required flag means the same thing on all of them.
 *
 * Values are calendar days as 'yyyy-MM-dd', which compare correctly as strings.
 */
import { parseTyped, toDayValue } from './dates';

export interface DateRules {
  /** Inclusive lower bound, 'yyyy-MM-dd'. */
  min?: string | null;
  /** Inclusive upper bound, 'yyyy-MM-dd'. */
  max?: string | null;
  /** An empty value is an error rather than a cleared field. */
  required?: boolean;
}

export type DateProblem = 'format' | 'required' | 'beforeMin' | 'afterMax';

/** Why a committed day value breaks the rules, or null when it does not. */
export function checkDay(value: string | null | undefined, rules: DateRules): DateProblem | null {
  if (!value) return rules.required ? 'required' : null;
  const day = value.slice(0, 10);
  if (rules.min && day < rules.min.slice(0, 10)) return 'beforeMin';
  if (rules.max && day > rules.max.slice(0, 10)) return 'afterMax';
  return null;
}

export type TypedResult =
  | { ok: true; value: string | null }
  | { ok: false; problem: DateProblem };

/**
 * Read what the user typed into a day value. Empty text clears the field
 * unless it is required; text that does not parse, or parses to a day outside
 * the bounds, is rejected with the reason so the field can keep the text and
 * say what is wrong instead of throwing the input away.
 */
export function readTypedDay(text: string, rules: DateRules): TypedResult {
  const trimmed = text.trim();
  if (!trimmed) return rules.required ? { ok: false, problem: 'required' } : { ok: true, value: null };
  const parsed = parseTyped(trimmed);
  if (!parsed) return { ok: false, problem: 'format' };
  const value = toDayValue(parsed);
  const problem = checkDay(value, rules);
  return problem ? { ok: false, problem } : { ok: true, value };
}
