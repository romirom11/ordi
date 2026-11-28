/**
 * The deactivate dialog's line for open tasks the admin cannot see (ORD-39):
 * tasks in private projects they are not on are counted by the API, never
 * listed. The key reads "and N more …" under a list of visible tasks, and
 * stands on its own when every task is hidden; Intl's plural category
 * (English one/other; Ukrainian one/few/many/other) picks the form.
 */
export function hiddenTasksKey(hiddenCount: number, visibleCount: number, locale: string): string {
  const form = new Intl.PluralRules(locale).select(hiddenCount);
  return `settings.hiddenTasks${visibleCount > 0 ? 'More' : 'Only'}.${form}`;
}
