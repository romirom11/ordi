/**
 * The public intake form (PRD §8.6) as data: which fields it asks for, how
 * they read, and the rules a submission is checked against. One definition
 * serves the settings editor, the public page that renders it and the API
 * that validates what comes back.
 *
 * Four fields are built in, because the request row has columns for them:
 * the requester's name and email, the title (it becomes the task title) and
 * the details (the task description). They can be relabelled, reordered,
 * made required or hidden – except the title, which a request cannot do
 * without. Everything else is a custom field whose answer is stored on the
 * request and copied into the task description on accept.
 *
 * A `hidden` field is never rendered: its value comes from the site the form
 * is embedded in – prefilled by the embed loader (`data-prefill-<key>`), or
 * the address of the page the form was sent from. Prefilled values are what
 * the embedding page says they are, not verified facts about the visitor.
 */
import { z } from 'zod';

export const INTAKE_FIELD_TYPES = [
  'text', 'textarea', 'email', 'phone', 'url', 'number', 'date', 'select', 'checkbox', 'hidden',
] as const;
export type IntakeFieldType = (typeof INTAKE_FIELD_TYPES)[number];

/** Where a hidden field's value comes from: what the site passes, or the page's address. */
export const INTAKE_HIDDEN_SOURCES = ['prefill', 'page'] as const;
export type IntakeHiddenSource = (typeof INTAKE_HIDDEN_SOURCES)[number];

export const INTAKE_BUILTIN_KEYS = ['requesterName', 'requesterEmail', 'title', 'description'] as const;
export type IntakeBuiltinKey = (typeof INTAKE_BUILTIN_KEYS)[number];

const BUILTIN_TYPES: Record<IntakeBuiltinKey, IntakeFieldType> = {
  requesterName: 'text',
  requesterEmail: 'email',
  title: 'text',
  description: 'textarea',
};

export const INTAKE_MAX_FIELDS = 30;
export const INTAKE_MAX_ATTACHMENTS = 10;

/** Longest accepted answer per field type; anything longer is refused, not cut. */
const MAX_LENGTH: Record<IntakeFieldType, number> = {
  text: 500, textarea: 20_000, email: 254, phone: 40, url: 2_000,
  number: 40, date: 10, select: 120, checkbox: 5, hidden: 2_000,
};

export function isBuiltinIntakeKey(key: string): key is IntakeBuiltinKey {
  return (INTAKE_BUILTIN_KEYS as readonly string[]).includes(key);
}

export const intakeFieldSchema = z.object({
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, 'Letters, digits and _ only'),
  type: z.enum(INTAKE_FIELD_TYPES).default('text'),
  /** Empty on a built-in field = the public page's localized default label. */
  label: z.string().trim().max(120).default(''),
  placeholder: z.string().trim().max(200).default(''),
  help: z.string().trim().max(500).default(''),
  required: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** Choices of a `select` field. */
  options: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  /** Where a `hidden` field's value comes from. */
  source: z.enum(INTAKE_HIDDEN_SOURCES).default('prefill'),
});
export type IntakeField = z.infer<typeof intakeFieldSchema>;

export const intakeFormConfigSchema = z.object({
  /** Empty = the page's default heading. */
  heading: z.string().trim().max(160).default(''),
  intro: z.string().trim().max(2_000).default(''),
  submitLabel: z.string().trim().max(60).default(''),
  successMessage: z.string().trim().max(1_000).default(''),
  /** `#rrggbb` for the submit button and focus accents; null = the app's own. */
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
  fields: z.array(intakeFieldSchema).max(INTAKE_MAX_FIELDS).default([]),
  allowAttachments: z.boolean().default(false),
  maxAttachments: z.number().int().min(1).max(INTAKE_MAX_ATTACHMENTS).default(5),
  /** Email the requester a receipt when they leave an address. */
  acknowledge: z.boolean().default(true),
}).superRefine((config, ctx) => {
  const seen = new Set<string>();
  config.fields.forEach((field, index) => {
    if (seen.has(field.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'key'], message: 'Duplicate field key' });
    }
    seen.add(field.key);
    if (!isBuiltinIntakeKey(field.key) && !field.label) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'label'], message: 'A custom field needs a label' });
    }
    if (field.type === 'select' && !field.hidden && field.options.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields', index, 'options'], message: 'A choice field needs options' });
    }
  });
});
export type IntakeFormConfig = z.infer<typeof intakeFormConfigSchema>;

const DEFAULT_FIELDS: IntakeField[] = [
  { key: 'requesterName', type: 'text', label: '', placeholder: '', help: '', required: true, hidden: false, options: [], source: 'prefill' },
  { key: 'requesterEmail', type: 'email', label: '', placeholder: '', help: '', required: false, hidden: false, options: [], source: 'prefill' },
  { key: 'title', type: 'text', label: '', placeholder: '', help: '', required: true, hidden: false, options: [], source: 'prefill' },
  { key: 'description', type: 'textarea', label: '', placeholder: '', help: '', required: false, hidden: false, options: [], source: 'prefill' },
];

/** The form every project starts with: what the page asked for before it was configurable. */
export function defaultIntakeFormConfig(): IntakeFormConfig {
  return {
    heading: '', intro: '', submitLabel: '', successMessage: '', accentColor: null,
    fields: DEFAULT_FIELDS.map((f) => ({ ...f })),
    allowAttachments: false, maxAttachments: 5, acknowledge: true,
  };
}

/**
 * A stored config made whole: unreadable → the default form, built-in fields
 * keep their fixed types and are always present (a dropped one comes back
 * hidden, a dropped title comes back first), the title is always shown and
 * required, a hidden field is never required, and only choice fields carry
 * options. A `hidden`-type field is never required either (the visitor could
 * not fix it) and has no placeholder or hint.
 */
export function normalizeIntakeFormConfig(raw: unknown): IntakeFormConfig {
  if (raw == null) return defaultIntakeFormConfig();
  const parsed = intakeFormConfigSchema.safeParse(raw);
  if (!parsed.success) return defaultIntakeFormConfig();
  const config = parsed.data;
  const fields = config.fields.map((field) => {
    const next = { ...field };
    if (isBuiltinIntakeKey(next.key)) next.type = BUILTIN_TYPES[next.key];
    if (next.key === 'title') { next.hidden = false; next.required = true; }
    if (next.hidden) next.required = false;
    if (next.type !== 'select') next.options = [];
    if (next.type === 'hidden') { next.required = false; next.placeholder = ''; next.help = ''; }
    else next.source = 'prefill';
    return next;
  });
  for (const builtin of DEFAULT_FIELDS) {
    if (fields.some((f) => f.key === builtin.key)) continue;
    if (builtin.key === 'title') fields.unshift({ ...builtin });
    else fields.push({ ...builtin, hidden: true, required: false });
  }
  return { ...config, fields };
}

/**
 * The fields the form takes, in order: all but those switched off. The
 * `hidden`-type ones among them are taken but not drawn.
 */
export function visibleIntakeFields(config: IntakeFormConfig): IntakeField[] {
  return config.fields.filter((f) => !f.hidden);
}

export type IntakeAnswerValue = string | boolean;

/** A custom field's answer, with the label it was asked under. */
export interface IntakeAnswer {
  key: string;
  label: string;
  type: IntakeFieldType;
  value: IntakeAnswerValue;
}

export type IntakeFieldError = 'required' | 'invalid' | 'too_long';

export type IntakeSubmissionResult =
  | {
    ok: true;
    requesterName: string | null;
    requesterEmail: string | null;
    title: string;
    description: string;
    answers: IntakeAnswer[];
  }
  | { ok: false; errors: Record<string, IntakeFieldError> };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9()\s.-]{5,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checked(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on' || value === '1' || value === 'yes';
}

function validDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** One field's answer: the cleaned value, nothing (empty), or why it is refused. */
function checkField(field: IntakeField, raw: unknown):
  { value: IntakeAnswerValue | null } | { error: IntakeFieldError } {
  if (field.type === 'checkbox') {
    const on = checked(raw);
    if (field.required && !on) return { error: 'required' };
    return { value: on ? true : null };
  }
  const value = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  // Nobody can correct a hidden value, so an overlong one is cut, not refused.
  if (field.type === 'hidden') return { value: value ? value.slice(0, MAX_LENGTH.hidden) : null };
  if (!value) return field.required ? { error: 'required' } : { value: null };
  if (value.length > MAX_LENGTH[field.type]) return { error: 'too_long' };
  switch (field.type) {
    case 'email': return EMAIL_RE.test(value) ? { value: value.toLowerCase() } : { error: 'invalid' };
    case 'phone': return PHONE_RE.test(value) ? { value } : { error: 'invalid' };
    case 'url': return validUrl(value) ? { value } : { error: 'invalid' };
    case 'number': return Number.isFinite(Number(value)) ? { value } : { error: 'invalid' };
    case 'date': return validDate(value) ? { value } : { error: 'invalid' };
    case 'select': return field.options.includes(value) ? { value } : { error: 'invalid' };
    default: return { value };
  }
}

/**
 * Check a submission against the form. Hidden fields are ignored whatever
 * was sent for them, and so are keys the form does not have.
 */
export function validateIntakeSubmission(
  config: IntakeFormConfig,
  values: Record<string, unknown>,
): IntakeSubmissionResult {
  const errors: Record<string, IntakeFieldError> = {};
  const builtins: Partial<Record<IntakeBuiltinKey, string>> = {};
  const answers: IntakeAnswer[] = [];
  for (const field of visibleIntakeFields(config)) {
    const result = checkField(field, values[field.key]);
    if ('error' in result) {
      errors[field.key] = result.error;
      continue;
    }
    if (result.value === null) continue;
    if (isBuiltinIntakeKey(field.key)) builtins[field.key] = String(result.value);
    else answers.push({ key: field.key, label: field.label, type: field.type, value: result.value });
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    requesterName: builtins.requesterName ?? null,
    requesterEmail: builtins.requesterEmail ?? null,
    title: builtins.title!,
    description: builtins.description ?? '',
    answers,
  };
}

/** An answer's value as text; a ticked box reads ✓. */
export function intakeAnswerText(answer: IntakeAnswer): string {
  return answer.value === true ? '✓' : String(answer.value);
}

/**
 * A field key as prefill names are matched against it: case, `_` and `-`
 * ignored, since HTML lowercases attribute names (`data-prefill-requester-email`
 * and `data-prefill-requesteremail` both reach `requesterEmail`).
 */
export function intakePrefillMatchKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

/** The container attribute the embed loader reads a field's prefill from. */
export function intakePrefillAttribute(key: string): string {
  return `data-prefill-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}
