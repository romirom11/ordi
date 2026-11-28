/**
 * The deactivate dialog's tail for open tasks the admin cannot see (ORD-39).
 * The API lists at most a page of the tasks in projects the admin can open
 * and only counts the rest – a private project they are not on, or any
 * project for a role that reaches only its own memberships – so the wording
 * says "projects you cannot open", not "private".
 */

/**
 * The dictionary key for the hidden-tasks line: "and N more …" under a list
 * of visible tasks, a line of its own when every task is hidden. Intl's
 * plural category (English one/other; Ukrainian one/few/many/other) picks
 * the form.
 */
export function hiddenTasksKey(hiddenCount: number, visibleCount: number, locale: string): string {
  const form = new Intl.PluralRules(locale).select(hiddenCount);
  return `settings.hiddenTasks${visibleCount > 0 ? 'More' : 'Only'}.${form}`;
}

/**
 * What follows the listed tasks: an ellipsis when visible tasks were cut
 * off by the page, then the hidden-tasks line when there are any.
 */
export function previewTail(
  preview: { count: number; hiddenCount: number; listed: number },
  locale: string,
): { truncated: boolean; hiddenKey: string | null } {
  const visible = preview.count - preview.hiddenCount;
  return {
    truncated: visible > preview.listed,
    hiddenKey: preview.hiddenCount > 0 ? hiddenTasksKey(preview.hiddenCount, visible, locale) : null,
  };
}
