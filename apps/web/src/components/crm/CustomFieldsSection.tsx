/**
 * Workspace-defined custom fields for a record, rendered as a two-column card
 * in the wide content column. Extracted from the deal page when leads gained
 * custom fields; any entity from the custom-fields registry (leads, deals,
 * employees, …) edits them identically.
 *
 * Values carry free text and URLs – prose-length content that truncated into
 * unreadability in the 320px rail, which is why this lives in the wide column.
 */
import { useState } from 'react';
import type { CustomFieldEntity } from '@ordi/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, SlidersHorizontal } from 'lucide-react';
import { api } from '../../lib/api';
import { activeUsers } from '../../lib/queries';
import { usePersistedState } from '../../lib/prefs';
import { useT } from '../../lib/i18n';
import { Avatar, Card, cn, fmtDate } from '../ui';
import { DropdownMenu, MenuItem } from '../overlays';
import { DateField } from '../DatePicker';
import { useUsersLookup } from './shared';
import { DetailField, SectionHeader } from './detail';
import { FieldIcon } from '../fieldIcons';

export interface FieldDef {
  id: string; key: string; label: string; type: string;
  options?: { value: string; label: string }[]; deprecated?: boolean;
  groupId?: string | null; icon?: string | null;
}

export function fieldValueIsEmpty(v: unknown): boolean {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** Fetch the (non-deprecated) definitions of one entity's custom fields.
 * With projectId the project's own fields are included alongside global ones. */
export function useFieldDefs(entityType: CustomFieldEntity, projectId?: string) {
  return useQuery<FieldDef[]>({
    queryKey: ['custom-fields', entityType, projectId ?? null],
    queryFn: () => api.get<{ data: FieldDef[] }>(
      `/custom-fields?entityType=${entityType}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`,
    ).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/** The bare two-column grid of fields – reused wherever grouped fields render. */
export function CustomFieldsGrid({ defs, values: valuesProp, editable, onSave }: {
  defs: FieldDef[];
  values?: Record<string, unknown>;
  editable: boolean;
  /** Receives the full value map with the changed key applied; the API merges by key. */
  onSave: (customFields: Record<string, unknown>) => void;
}) {
  const usersQ = useUsersLookup();
  const values = valuesProp ?? {};
  const save = (key: string, v: unknown) => onSave({ ...values, [key]: v });
  return (
    <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
      {defs.map((f) => (
        <DetailField
          key={f.id}
          preserveCase
          label={f.icon
            ? <span className="inline-flex items-center gap-1.5"><FieldIcon name={f.icon} size={12} className="text-faint" />{f.label}</span>
            : f.label}
        >
          <CustomFieldValue field={f} value={values[f.key]} editable={editable} users={usersQ.data ?? []} onSave={(v) => save(f.key, v)} />
        </DetailField>
      ))}
    </div>
  );
}

export function CustomFieldsSection({ entityType, projectId, values: valuesProp, editable, onSave, collapsible }: {
  entityType: CustomFieldEntity;
  /** Include this project's own fields alongside the workspace-wide ones. */
  projectId?: string;
  values?: Record<string, unknown>;
  editable: boolean;
  /** Receives the full value map with the changed key applied; the API merges by key. */
  onSave: (customFields: Record<string, unknown>) => void;
  /** Collapsible with a persisted toggle; starts collapsed while every field is empty. */
  collapsible?: boolean;
}) {
  const t = useT();
  const defsQ = useFieldDefs(entityType, projectId);
  const values = valuesProp ?? {};
  // null until the user has ever toggled – then their choice wins.
  const [stored, setStored] = usePersistedState<boolean | null>(
    collapsible ? `ordi:cf:collapsed:${entityType}` : undefined,
    null,
    (raw) => (typeof raw === 'boolean' ? raw : null),
  );
  // Empty fields render only while they can be filled – a read-only record
  // showing a grid of dashes says nothing. Grouped fields belong to their
  // group's section (EmployeeFieldGroups) and are skipped here.
  const defs = (defsQ.data ?? [])
    .filter((f) => !f.deprecated && !f.groupId)
    .filter((f) => editable || !fieldValueIsEmpty(values[f.key]));
  if (defs.length === 0) return null;

  const filled = defs.filter((f) => !fieldValueIsEmpty(values[f.key])).length;
  const collapsed = collapsible ? (stored ?? filled === 0) : false;

  return (
    <section>
      {collapsible ? (
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => setStored(!collapsed)}
          className="mb-3 flex items-center gap-2 text-[13px] font-semibold transition-colors hover:text-foreground"
        >
          <span className="text-muted-foreground"><SlidersHorizontal size={15} /></span>
          {t('crm.customFields')}
          {filled > 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{filled}</span>}
          <ChevronDown size={14} className={cn('text-faint transition-transform', collapsed && '-rotate-90')} />
        </button>
      ) : (
        <SectionHeader icon={<SlidersHorizontal size={15} />} title={t('crm.customFields')} />
      )}
      {!collapsed && (
        <Card className="p-4">
          <CustomFieldsGrid defs={defs} values={values} editable={editable} onSave={onSave} />
        </Card>
      )}
    </section>
  );
}

/** One custom field value: read view + per-type editor. */
function CustomFieldValue({ field: f, value: v, editable, users, onSave }: {
  field: FieldDef; value: unknown; editable: boolean;
  users: { id: string; name: string; avatar?: string | null; isActive?: boolean }[];
  onSave: (v: unknown) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const empty = <span className="text-faint">–</span>;

  // ── Always-live controls (no separate edit state needed) ──
  if (f.type === 'checkbox') {
    if (!editable) return v ? <span>✓</span> : empty;
    return (
      <button
        role="checkbox"
        aria-checked={!!v}
        onClick={() => onSave(!v)}
        className={cn('grid h-4 w-4 place-items-center rounded border transition-colors',
          v ? 'border-primary bg-primary text-white' : 'border-border-strong hover:border-primary/60')}
      >
        {v ? '✓' : ''}
      </button>
    );
  }
  if (f.type === 'select') {
    const label = f.options?.find((o) => o.value === v)?.label ?? (v ? String(v) : null);
    if (!editable) return label ? <span>{label}</span> : empty;
    return (
      <DropdownMenu
        align="start"
        trigger={<button className="block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted">{label ?? empty} <ChevronDown size={11} className="inline text-faint" /></button>}
      >
        <MenuItem checked={v == null || v === ''} onSelect={() => onSave(null)}>–</MenuItem>
        {(f.options ?? []).map((o) => (
          <MenuItem key={o.value} checked={o.value === v} onSelect={() => o.value !== v && onSave(o.value)}>{o.label}</MenuItem>
        ))}
      </DropdownMenu>
    );
  }
  if (f.type === 'multiselect') {
    const arr = Array.isArray(v) ? (v as string[]) : [];
    const label = arr.length ? arr.map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(', ') : null;
    if (!editable) return label ? <span>{label}</span> : empty;
    return (
      <DropdownMenu
        align="start"
        trigger={<button className="block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted">{label ?? empty} <ChevronDown size={11} className="inline text-faint" /></button>}
      >
        {(f.options ?? []).map((o) => (
          <MenuItem
            key={o.value}
            checked={arr.includes(o.value)}
            onSelect={() => onSave(arr.includes(o.value) ? arr.filter((x) => x !== o.value) : [...arr, o.value])}
          >
            {o.label}
          </MenuItem>
        ))}
      </DropdownMenu>
    );
  }
  if (f.type === 'date') {
    if (!editable) return v ? <span className="tabular-nums">{fmtDate(String(v))}</span> : empty;
    return <DateField size="sm" value={(v as string) ?? null} onChange={(next) => onSave(next)} className="w-full" />;
  }
  if (f.type === 'user') {
    const u = users.find((x) => x.id === v);
    if (!editable) return u ? <span className="inline-flex items-center gap-1.5"><Avatar name={u.name} src={u.avatar} size={16} /> {u.name}</span> : empty;
    return (
      <DropdownMenu
        align="start"
        trigger={<button className="block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted">{u ? <span className="inline-flex items-center gap-1.5"><Avatar name={u.name} src={u.avatar} size={16} /> {u.name}</span> : empty} <ChevronDown size={11} className="inline text-faint" /></button>}
      >
        <MenuItem checked={!u} onSelect={() => onSave(null)}>{t('crm.noOwner')}</MenuItem>
        {activeUsers(users).map((x) => (
          <MenuItem key={x.id} checked={x.id === v} onSelect={() => x.id !== v && onSave(x.id)}>
            <span className="flex items-center gap-2"><Avatar name={x.name} src={x.avatar} size={18} /> {x.name}</span>
          </MenuItem>
        ))}
      </DropdownMenu>
    );
  }

  // ── text / number / url: click-to-edit ──
  const display = v == null || v === '' ? null
    : f.type === 'url'
      ? <a href={String(v)} target="_blank" rel="noreferrer" className="break-words text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{String(v)}</a>
      : <span className={cn(f.type === 'number' && 'tabular-nums')}>{String(v)}</span>;
  if (!editable) return display ?? empty;
  if (editing) {
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (f.type === 'number') {
        const n = Number(next);
        if (next === '') onSave(null);
        else if (Number.isFinite(n) && n !== v) onSave(n);
        return;
      }
      if (next !== (v ?? '')) onSave(next || null);
    };
    return (
      <input
        autoFocus
        type={f.type === 'number' ? 'number' : 'text'}
        value={draft}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        className="min-h-7 w-full rounded-md border border-primary/40 bg-transparent px-1.5 py-1 text-[13px] outline-none focus:ring-2 focus:ring-ring/25"
      />
    );
  }
  return (
    <button
      onClick={() => { setDraft(v != null ? String(v) : ''); setEditing(true); }}
      className="block w-full max-w-full break-words rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted"
    >
      {display ?? empty}
    </button>
  );
}
