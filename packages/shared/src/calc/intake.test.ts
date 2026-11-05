import { describe, it, expect } from 'vitest';
import {
  defaultIntakeFormConfig, normalizeIntakeFormConfig, intakeFormConfigSchema,
  validateIntakeSubmission, visibleIntakeFields,
} from './intake';

describe('normalizeIntakeFormConfig', () => {
  it('falls back to the default form for nothing or garbage', () => {
    expect(normalizeIntakeFormConfig(null)).toEqual(defaultIntakeFormConfig());
    expect(normalizeIntakeFormConfig({ fields: 'nope' })).toEqual(defaultIntakeFormConfig());
  });

  it('keeps the title shown and required, and built-ins on their own types', () => {
    const config = normalizeIntakeFormConfig({
      fields: [
        { key: 'title', type: 'number', hidden: true, required: false },
        { key: 'requesterEmail', type: 'text', required: true },
      ],
    });
    const title = config.fields.find((f) => f.key === 'title')!;
    expect(title).toMatchObject({ type: 'text', hidden: false, required: true });
    expect(config.fields.find((f) => f.key === 'requesterEmail')!.type).toBe('email');
  });

  it('brings back dropped built-ins hidden, and a dropped title first', () => {
    const config = normalizeIntakeFormConfig({ fields: [{ key: 'budget', label: 'Budget' }] });
    expect(config.fields[0]!.key).toBe('title');
    const name = config.fields.find((f) => f.key === 'requesterName')!;
    expect(name.hidden).toBe(true);
    expect(visibleIntakeFields(config).map((f) => f.key)).toEqual(['title', 'budget']);
  });

  it('never requires a hidden field and drops options off non-choice fields', () => {
    const config = normalizeIntakeFormConfig({
      fields: [{ key: 'title' }, { key: 'size', label: 'Size', type: 'text', hidden: true, required: true, options: ['S'] }],
    });
    expect(config.fields.find((f) => f.key === 'size')).toMatchObject({ required: false, options: [] });
  });
});

describe('intakeFormConfigSchema', () => {
  it('refuses duplicate keys, unlabelled custom fields and choice fields without options', () => {
    const result = intakeFormConfigSchema.safeParse({
      fields: [
        { key: 'title' },
        { key: 'title' },
        { key: 'budget' },
        { key: 'plan', label: 'Plan', type: 'select' },
      ],
    });
    expect(result.success).toBe(false);
    const messages = result.success ? [] : result.error.issues.map((i) => i.message);
    expect(messages).toEqual(expect.arrayContaining([
      'Duplicate field key', 'A custom field needs a label', 'A choice field needs options',
    ]));
  });
});

describe('validateIntakeSubmission', () => {
  const config = normalizeIntakeFormConfig({
    fields: [
      { key: 'requesterName', required: true },
      { key: 'requesterEmail' },
      { key: 'title' },
      { key: 'description' },
      { key: 'plan', label: 'Plan', type: 'select', options: ['Basic', 'Pro'], required: true },
      { key: 'site', label: 'Website', type: 'url' },
      { key: 'deadline', label: 'Deadline', type: 'date' },
      { key: 'consent', label: 'I agree', type: 'checkbox', required: true },
      { key: 'internal', label: 'Internal', type: 'text', hidden: true },
    ],
  });

  it('splits built-ins from custom answers and skips empty optional ones', () => {
    const result = validateIntakeSubmission(config, {
      requesterName: ' Olena ', requesterEmail: 'Olena@Example.com', title: 'New landing',
      plan: 'Pro', site: '', consent: 'on', internal: 'smuggled', unknown: 'x',
    });
    expect(result).toEqual({
      ok: true,
      requesterName: 'Olena',
      requesterEmail: 'olena@example.com',
      title: 'New landing',
      description: '',
      answers: [
        { key: 'plan', label: 'Plan', type: 'select', value: 'Pro' },
        { key: 'consent', label: 'I agree', type: 'checkbox', value: true },
      ],
    });
  });

  it('reports every bad field at once', () => {
    const result = validateIntakeSubmission(config, {
      requesterEmail: 'not-an-email', title: 'x'.repeat(501), plan: 'Enterprise',
      site: 'javascript:alert(1)', deadline: '2026-02-30',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        requesterName: 'required',
        requesterEmail: 'invalid',
        title: 'too_long',
        plan: 'invalid',
        site: 'invalid',
        deadline: 'invalid',
        consent: 'required',
      },
    });
  });
});
