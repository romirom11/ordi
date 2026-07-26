/**
 * Parse `KEY-\d+` task references from git branch names, commit messages and
 * PR/MR titles/descriptions (PRD §13.1). Pure & unit-tested.
 */

export interface TaskRef {
  key: string;
  number: number;
  raw: string;
}

const PATTERN = /\b([A-Z][A-Z0-9]{1,4})-(\d+)\b/g;
const PATTERN_ANY_CASE = /\b([A-Za-z][A-Za-z0-9]{1,4})-(\d+)\b/g;

/**
 * `anyCase` exists for branch names: our own "Copy branch name" convention
 * lowercases the key (feature/sol-42-slug), so branch parsing must not demand
 * uppercase. Free-form text (commits, PR bodies) stays uppercase-only – there
 * "utf-8" must not become task 8 of project UTF.
 */
export function parseTaskRefs(text: string | null | undefined, opts?: { anyCase?: boolean }): TaskRef[] {
  if (!text) return [];
  const pattern = opts?.anyCase ? PATTERN_ANY_CASE : PATTERN;
  const found = new Map<string, TaskRef>();
  for (const m of text.matchAll(pattern)) {
    const raw = m[0];
    const key = m[1]!.toUpperCase();
    const number = Number(m[2]);
    found.set(`${key}-${number}`, { key, number, raw });
  }
  return [...found.values()];
}

/** Generate a branch name from a template (PRD §13.1 "Copy branch name"). */
export function buildBranchName(params: {
  template?: string;
  typePrefix?: string;
  key: string;
  number: number;
  title: string;
}): string {
  const slug = params.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const template = params.template ?? '{type}/{key}-{number}-{slug}';
  return template
    .replace('{type}', params.typePrefix ?? 'feature')
    .replace('{key}', params.key.toLowerCase())
    .replace('{number}', String(params.number))
    .replace('{slug}', slug);
}
