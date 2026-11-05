/**
 * Turn what a client sent ("login: x / password: y / https://…") into secret
 * fields the person then confirms. Pure, so it is tested on its own.
 *
 * When in doubt a value becomes a password: guessing "secret" for something
 * harmless costs a click to reveal, guessing "text" for a password shows it
 * to everyone who opens the list.
 */
export type PastedFieldType = 'text' | 'url' | 'password' | 'api_key' | 'note';

export interface PastedField { key: string; label: string; type: PastedFieldType; value: string }

export interface FieldLabels { login: string; password: string; url: string; apiKey: string; note: string }

const URL_RE = /^https?:\/\/\S+$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** `label: value` or `label = value`; the label is short and has no URL in it. */
const PAIR_RE = /^\s*([^:=\n]{1,40}?)\s*[:=]\s*(.+?)\s*$/;

/** Whole words in any script: `\b` only knows ASCII letters, so "Пароль" would never match. */
const words = (alternatives: string) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'iu');
const LOGIN = words('login|user(?:name)?|e-?mail|account|логін|користувач|пошта|акаунт');
const PASSWORD = words('pass(?:word)?|pwd|пароль');
const KEY = words('api[ _-]?key|key|token|secret|ключ|токен|секрет');
const URL_LABEL = words('url|link|site|host|address|admin|panel|посилання|адреса|сайт|панель');
const NOTE = words('note|comment|нотатка|примітка|коментар');

/** Treat a line as `label: value` only when the part before the colon is not a URL scheme. */
function splitPair(line: string): { label: string; value: string } | null {
  if (URL_RE.test(line.trim())) return null;
  const m = PAIR_RE.exec(line);
  if (!m) return null;
  return { label: m[1]!.trim(), value: m[2]!.trim() };
}

function typeFor(label: string, value: string): PastedFieldType {
  if (PASSWORD.test(label)) return 'password';
  if (KEY.test(label)) return 'api_key';
  if (NOTE.test(label)) return 'note';
  if (URL_RE.test(value)) return 'url';
  if (URL_LABEL.test(label)) return 'url';
  if (LOGIN.test(label) || EMAIL_RE.test(value)) return 'text';
  return /\s/.test(value) ? 'text' : 'password';
}

const DEFAULT_KEY: Record<PastedFieldType, string> = { text: 'login', url: 'url', password: 'password', api_key: 'api_key', note: 'note' };

/** lower_snake ascii from a label, or the type's default key when nothing ascii is left (Cyrillic labels). */
export function fieldKeyFor(label: string, type: PastedFieldType): string {
  const slug = label.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  const key = /^[a-z]/.test(slug) ? slug : DEFAULT_KEY[type];
  return key;
}

function unique(fields: PastedField[]): PastedField[] {
  const seen = new Map<string, number>();
  return fields.map((f) => {
    const n = (seen.get(f.key) ?? 0) + 1;
    seen.set(f.key, n);
    return n === 1 ? f : { ...f, key: `${f.key}_${n}`.slice(0, 32) };
  });
}

export function pasteToFields(text: string, labels: FieldLabels): PastedField[] {
  const out: PastedField[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const pair = splitPair(line);
    if (pair && pair.value) {
      const type = typeFor(pair.label, pair.value);
      const label = pair.label.charAt(0).toUpperCase() + pair.label.slice(1);
      out.push({ key: fieldKeyFor(pair.label, type), label, type, value: pair.value });
      continue;
    }
    // A bare line: a link, a login, or something that looks like a secret.
    if (URL_RE.test(line)) out.push({ key: 'url', label: labels.url, type: 'url', value: line });
    else if (EMAIL_RE.test(line)) out.push({ key: 'login', label: labels.login, type: 'text', value: line });
    else if (!/\s/.test(line)) {
      const looksLikeKey = line.length >= 20 && /^[A-Za-z0-9_\-.]+$/.test(line);
      out.push(looksLikeKey
        ? { key: 'api_key', label: labels.apiKey, type: 'api_key', value: line }
        : { key: 'password', label: labels.password, type: 'password', value: line });
    } else {
      out.push({ key: 'note', label: labels.note, type: 'note', value: line });
    }
  }
  return unique(out);
}
