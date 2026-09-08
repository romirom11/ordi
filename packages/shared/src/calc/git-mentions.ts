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
/** Cyrillic → Latin (Ukrainian official romanization, plus the Russian-only letters). */
const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
  ш: 'sh', щ: 'shch', ю: 'iu', я: 'ia', ь: '', ъ: '', ы: 'y', э: 'e', ё: 'e',
};

/**
 * A branch-safe slug of a title: Cyrillic transliterated, accents stripped,
 * everything else collapsed to dashes. Empty when nothing survives (a title
 * of emoji or CJK), and the caller drops the segment rather than leaving a
 * dangling dash.
 */
export function slugifyTitle(title: string, max = 50): string {
  return title
    .toLowerCase()
    .replace(/[\u0400-\u04ff]/g, (ch) => CYRILLIC[ch] ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

export function buildBranchName(params: {
  template?: string;
  typePrefix?: string;
  key: string;
  number: number;
  title: string;
}): string {
  const slug = slugifyTitle(params.title);
  const template = params.template ?? '{type}/{key}-{number}-{slug}';
  const name = template
    .replace('{type}', params.typePrefix ?? 'feature')
    .replace('{key}', params.key.toLowerCase())
    .replace('{number}', String(params.number))
    .replace('{slug}', slug);
  // An empty slug must not leave "key-12-" behind.
  return name.replace(/-+(?=\/|$)/g, '').replace(/-{2,}/g, '-');
}
