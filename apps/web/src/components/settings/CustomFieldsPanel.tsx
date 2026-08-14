/**
 * Settings → Custom fields (PRD §5.5). Definitions per entity type: create,
 * non-destructive edit (label, options, flags – key and type are immutable
 * once records may hold values), deprecate and delete.
 *
 * Until this panel grew edit/delete, the API had the full CRUD and an options
 * column, but the app could only ever add a field – a select created here had
 * no way to receive its choices.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '@ordi/shared';
import { api, ApiError, qs } from '../../lib/api';
import { Badge, Button, EmptyState, IconButton, Input, Select, Skeleton, Spinner, Switch } from '../ui';
import { Dialog, ConfirmDialog, toast } from '../overlays';
import { SectionHead, Field, RowList, AnimatedRow, Disclosure } from './primitives';
import { FieldIcon, IconPicker } from '../fieldIcons';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.customFieldsDesc': 'Add custom fields to any entity type.',
    'cfields.edit': 'Edit field',
    'cfields.keyHint': 'Lowercase snake_case. Set once – values are stored under this key.',
    'cfields.immutableHint': 'Key and type are fixed after creation; records may already hold values.',
    'cfields.options': 'Options',
    'cfields.addOption': 'Add option',
    'cfields.noOptions': 'No options yet – add the choices this field offers.',
    'cfields.optionValue': 'value',
    'cfields.optionsHint': 'The value is what records store; renaming a label is safe, changing a value orphans existing records.',
    'cfields.requiredHint': 'Shown as required in forms.',
    'cfields.showInList': 'Show in list views',
    'cfields.sortable': 'Sortable',
    'cfields.sortableHint': 'Allow list views to sort by this field.',
    'cfields.advanced': 'Advanced',
    'cfields.indexed': 'Indexed',
    'cfields.indexedHint': 'Create a database index for frequent filtering. Cannot be undone here.',
    'cfields.deprecated': 'Deprecated',
    'cfields.deprecatedHint': 'Hide from records without losing stored values.',
    'cfields.deleteTitle': 'Delete custom field',
    'cfields.deleteConfirm': 'Delete “{label}”? The definition disappears everywhere; values already stored on records are kept but no longer shown. Deprecate instead to hide it reversibly.',
    'cfields.groups': 'Field groups',
    'cfields.groupsHint': 'Groups bound fields into access units – who sees each group is configured in Settings → Roles.',
    'cfields.addGroup': 'Add group',
    'cfields.groupName': 'Group name',
    'cfields.renameGroup': 'Rename group',
    'cfields.deleteGroupTitle': 'Delete field group',
    'cfields.deleteGroupConfirm': 'Delete “{name}”? Its fields stay, but fall back to the ungrouped default visibility.',
    'cfields.group': 'Group',
    'cfields.noGroup': 'No group',
    'cfields.projectFields': 'Project custom fields',
    'cfields.projectFieldsDesc': 'Task fields that exist only in this project, on top of the workspace-wide ones.',
  },
  uk: {
    'settings.customFieldsDesc': 'Додавайте власні поля до будь-якого типу сутностей.',
    'cfields.edit': 'Редагувати поле',
    'cfields.keyHint': 'Малі літери, snake_case. Задається один раз – значення зберігаються під цим ключем.',
    'cfields.immutableHint': 'Ключ і тип не змінюються після створення; записи вже можуть містити значення.',
    'cfields.options': 'Опції',
    'cfields.addOption': 'Додати опцію',
    'cfields.noOptions': 'Ще немає опцій – додайте варіанти для вибору.',
    'cfields.optionValue': 'значення',
    'cfields.optionsHint': 'Записи зберігають value; перейменувати мітку безпечно, а зміна value відв’яже наявні записи.',
    'cfields.requiredHint': 'Показується як обовʼязкове у формах.',
    'cfields.showInList': 'Показувати у списках',
    'cfields.sortable': 'Сортування',
    'cfields.sortableHint': 'Дозволити сортувати списки за цим полем.',
    'cfields.advanced': 'Додатково',
    'cfields.indexed': 'Індексоване',
    'cfields.indexedHint': 'Створити індекс у базі для частих фільтрів. Тут скасувати не можна.',
    'cfields.deprecated': 'Застаріле',
    'cfields.deprecatedHint': 'Сховати з записів, не втрачаючи збережені значення.',
    'cfields.deleteTitle': 'Видалити кастомне поле',
    'cfields.deleteConfirm': 'Видалити «{label}»? Визначення зникне всюди; вже збережені значення залишаться в записах, але не показуватимуться. Щоб сховати оборотно – позначте поле застарілим.',
    'cfields.groups': 'Групи полів',
    'cfields.groupsHint': 'Групи об’єднують поля в одиниці доступу – хто бачить кожну групу, налаштовується в Налаштування → Ролі.',
    'cfields.addGroup': 'Додати групу',
    'cfields.groupName': 'Назва групи',
    'cfields.renameGroup': 'Перейменувати групу',
    'cfields.deleteGroupTitle': 'Видалити групу полів',
    'cfields.deleteGroupConfirm': 'Видалити «{name}»? Поля залишаться, але повернуться до стандартної видимості без групи.',
    'cfields.group': 'Група',
    'cfields.noGroup': 'Без групи',
    'cfields.projectFields': 'Кастомні поля проекту',
    'cfields.projectFieldsDesc': 'Поля задач, що діють лише в цьому проекті – додатково до полів усього воркспейсу.',
  },
});

interface CustomField {
  id: string; key: string; label?: string | null; type?: string | null;
  options?: { value: string; label: string }[] | null;
  required?: boolean; position?: number; showInList?: boolean; isSortable?: boolean;
  indexed?: boolean; deprecated?: boolean; groupId?: string | null; icon?: string | null;
  projectId?: string | null;
}

interface FieldGroup { id: string; name: string; icon?: string | null; position?: number }

/** Group management + the access story live on employees for now. */
const GROUPED_ENTITY = 'employees';

const OPTION_TYPES = ['select', 'multiselect'];

/**
 * With `projectId` the panel manages that project's own task fields (rendered
 * inside the project's settings tab): entity is fixed to tasks, the list shows
 * only the project-scoped definitions, and creates carry the projectId.
 */
export function CustomFieldsPanel({ projectId }: { projectId?: string } = {}) {
  const t = useT();
  const qc = useQueryClient();
  const [entityType, setEntityType] = useState<string>(projectId ? 'tasks' : 'companies');
  const fieldsQ = useQuery({
    queryKey: ['customFields', entityType, projectId ?? null],
    queryFn: () => api.get<{ data: CustomField[] }>('/custom-fields' + qs({ entityType, ...(projectId ? { projectId } : {}) })),
  });
  const rows = (fieldsQ.data?.data ?? [])
    .filter((f) => (projectId ? f.projectId === projectId : !f.projectId))
    .slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.key.localeCompare(b.key));
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [deleting, setDeleting] = useState<CustomField | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['customFields', entityType] });
    // The CRM record sections cache definitions under their own key.
    qc.invalidateQueries({ queryKey: ['custom-fields'] });
  };

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/custom-fields/${id}`),
    onSuccess: () => { setDeleting(null); invalidate(); toast(t('common.saved')); },
    onError: (e) => { setDeleting(null); toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')); },
  });

  const groupsQ = useQuery({
    queryKey: ['fieldGroups', entityType],
    queryFn: () => api.get<{ data: FieldGroup[] }>('/custom-field-groups' + qs({ entityType })).then((r) => r.data),
    enabled: entityType === GROUPED_ENTITY,
  });
  const groups = groupsQ.data ?? [];
  const groupName = (id?: string | null) => groups.find((g) => g.id === id)?.name;

  return (
    <div>
      <SectionHead
        title={t(projectId ? 'cfields.projectFields' : 'settings.customFields')}
        desc={t(projectId ? 'cfields.projectFieldsDesc' : 'settings.customFieldsDesc')}
        actions={
          <div className="flex items-center gap-2">
            {!projectId && (
              <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="w-36">
                {CUSTOM_FIELD_ENTITIES.map((et) => <option key={et} value={et}>{et}</option>)}
              </Select>
            )}
            <Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> {t('settings.addField')}</Button>
          </div>
        }
      />

      {fieldsQ.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<SlidersHorizontal size={18} />} title={t('settings.noCustomFields')} />
      ) : (
        <RowList>
          {rows.map((f, i) => (
            <AnimatedRow key={f.id} index={i} className="group flex items-center gap-3 border-b border-border px-3 py-2.5 text-[13px] last:border-0">
              <FieldIcon name={f.icon} size={14} className="shrink-0 text-faint" />
              <span className="font-mono text-[11px] text-muted-foreground">{f.key}</span>
              <span className={f.deprecated ? 'flex-1 text-muted-foreground line-through' : 'flex-1'}>{f.label ?? '–'}</span>
              {groupName(f.groupId) && <Badge className="bg-primary/10 text-primary">{groupName(f.groupId)}</Badge>}
              {OPTION_TYPES.includes(f.type ?? '') && (
                <span className="hidden max-w-56 truncate text-xs text-muted-foreground sm:block">
                  {(f.options ?? []).map((o) => o.label).join(' · ')}
                </span>
              )}
              <Badge>{f.type ?? '–'}</Badge>
              {f.required && <Badge className="bg-warning/15 text-warning">{t('settings.required')}</Badge>}
              {f.deprecated && <Badge className="bg-muted text-muted-foreground">{t('cfields.deprecated')}</Badge>}
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                <IconButton size="sm" aria-label={t('cfields.edit')} onClick={() => setEditing(f)}><Pencil size={14} /></IconButton>
                <IconButton size="sm" aria-label={t('common.delete')} className="text-destructive" onClick={() => setDeleting(f)}><Trash2 size={14} /></IconButton>
              </div>
            </AnimatedRow>
          ))}
        </RowList>
      )}

      {entityType === GROUPED_ENTITY && !projectId && <FieldGroupsBlock groups={groups} entityType={entityType} />}

      <FieldDialog
        open={createOpen || !!editing}
        entityType={entityType}
        projectId={projectId}
        field={editing}
        groups={entityType === GROUPED_ENTITY ? groups : []}
        onClose={() => { setCreateOpen(false); setEditing(null); }}
        onSaved={invalidate}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) del.mutate(deleting.id); }}
        title={t('cfields.deleteTitle')}
        body={t('cfields.deleteConfirm').replace('{label}', deleting?.label ?? deleting?.key ?? '')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}

/** Manage the entity's field groups: name + order; access lives in Settings → Roles. */
function FieldGroupsBlock({ groups, entityType }: { groups: FieldGroup[]; entityType: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<{ group: FieldGroup | null } | null>(null);
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FieldGroup | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['fieldGroups'] });
    qc.invalidateQueries({ queryKey: ['fieldGroupGrants'] });
  };

  const save = useMutation({
    mutationFn: () => dialog?.group
      ? api.patch(`/custom-field-groups/${dialog.group.id}`, { name: name.trim(), icon })
      : api.post('/custom-field-groups', { entityType, name: name.trim(), icon, position: groups.length }),
    onSuccess: () => { setDialog(null); invalidate(); toast(t('common.saved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/custom-field-groups/${id}`),
    onSuccess: () => { setDeleting(null); invalidate(); qc.invalidateQueries({ queryKey: ['customFields'] }); qc.invalidateQueries({ queryKey: ['custom-fields'] }); toast(t('common.saved')); },
    onError: (e) => { setDeleting(null); toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')); },
  });

  return (
    <div className="mt-8">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('cfields.groups')}</h3>
        <Button size="sm" variant="outline" onClick={() => { setName(''); setIcon(null); setDialog({ group: null }); }}>
          <Plus size={13} /> {t('cfields.addGroup')}
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('cfields.groupsHint')}</p>
      {groups.length > 0 && (
        <RowList>
          {groups.map((g, i) => (
            <AnimatedRow key={g.id} index={i} className="group flex items-center gap-3 border-b border-border px-3 py-2.5 text-[13px] last:border-0">
              <FieldIcon name={g.icon} size={14} className="shrink-0 text-faint" />
              <span className="flex-1 font-medium">{g.name}</span>
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                <IconButton size="sm" aria-label={t('cfields.renameGroup')} onClick={() => { setName(g.name); setIcon(g.icon ?? null); setDialog({ group: g }); }}><Pencil size={14} /></IconButton>
                <IconButton size="sm" aria-label={t('common.delete')} className="text-destructive" onClick={() => setDeleting(g)}><Trash2 size={14} /></IconButton>
              </div>
            </AnimatedRow>
          ))}
        </RowList>
      )}

      <Dialog open={!!dialog} onClose={() => setDialog(null)} title={dialog?.group ? t('cfields.renameGroup') : t('cfields.addGroup')} width={380}>
        <form className="space-y-3 p-4" onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) save.mutate(); }}>
          <Field label={t('cfields.groupName')}>
            <div className="flex items-center gap-2">
              <IconPicker value={icon} onChange={setIcon} />
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setDialog(null)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={!name.trim() || save.isPending}>
              {save.isPending ? <Spinner /> : dialog?.group ? t('common.save') : t('common.create')}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) del.mutate(deleting.id); }}
        title={t('cfields.deleteGroupTitle')}
        body={t('cfields.deleteGroupConfirm').replace('{name}', deleting?.name ?? '')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const slug = (s: string) => s.toLowerCase().trim().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function FieldDialog({ open, entityType, projectId, field, groups, onClose, onSaved }: {
  open: boolean; entityType: string; projectId?: string; field: CustomField | null; groups: FieldGroup[]; onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<string>('text');
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);
  const [required, setRequired] = useState(false);
  const [showInList, setShowInList] = useState(false);
  const [isSortable, setIsSortable] = useState(false);
  const [indexed, setIndexed] = useState(false);
  const [deprecated, setDeprecated] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [icon, setIcon] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKey(field?.key ?? '');
    setLabel(field?.label ?? '');
    setType(field?.type ?? 'text');
    setOptions(field?.options ?? []);
    setRequired(field?.required ?? false);
    setShowInList(field?.showInList ?? false);
    setIsSortable(field?.isSortable ?? false);
    setIndexed(field?.indexed ?? false);
    setDeprecated(field?.deprecated ?? false);
    setGroupId(field?.groupId ?? '');
    setIcon(field?.icon ?? null);
  }, [open, field]);

  const hasOptions = OPTION_TYPES.includes(type);
  const cleanOptions = options
    .map((o) => ({ label: o.label.trim(), value: o.value.trim() || slug(o.label) || o.label.trim() }))
    .filter((o) => o.label && o.value);

  const save = useMutation({
    mutationFn: () => {
      const flags = { required, showInList, isSortable, indexed };
      const opts = hasOptions ? { options: cleanOptions } : {};
      const group = groups.length ? { groupId: groupId || null } : {};
      return field
        ? api.patch(`/custom-fields/${field.id}`, { label: label.trim(), icon, ...opts, ...flags, ...group, deprecated })
        : api.post('/custom-fields', { entityType, ...(projectId ? { projectId } : {}), key, label: label.trim(), type, icon, ...opts, ...flags, ...group });
    },
    onSuccess: () => { onSaved(); toast(t('common.saved')); onClose(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });

  const valid = label.trim() && (field || KEY_RE.test(key));

  return (
    <Dialog open={open} onClose={onClose} title={field ? t('cfields.edit') : t('settings.addField')} width={460}>
      <form
        className="space-y-3.5 px-4 pb-4 pt-1"
        onSubmit={(e: FormEvent) => { e.preventDefault(); if (valid) save.mutate(); }}
      >
        <div className="flex gap-2">
          <Field label={t('projects.key')} className="w-40">
            <Input
              autoFocus={!field} value={key} disabled={!!field} placeholder="budget"
              onChange={(e) => setKey(e.target.value)} className="font-mono"
            />
          </Field>
          <Field label={t('dashboards.type')} className="w-36">
            <Select value={type} disabled={!!field} onChange={(e) => setType(e.target.value)} className="w-full">
              {CUSTOM_FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{ft}</option>)}
            </Select>
          </Field>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">{field ? t('cfields.immutableHint') : t('cfields.keyHint')}</p>

        <Field label={t('settings.fieldLabel')}>
          <div className="flex items-center gap-2">
            <IconPicker value={icon} onChange={setIcon} />
            <Input autoFocus={!!field} value={label} onChange={(e) => setLabel(e.target.value)} className="flex-1" />
          </div>
        </Field>

        {groups.length > 0 && (
          <Field label={t('cfields.group')}>
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} className="w-full">
              <option value="">{t('cfields.noGroup')}</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </Field>
        )}

        {hasOptions && (
          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">{t('cfields.options')}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setOptions((o) => [...o, { value: '', label: '' }])}>
                <Plus size={13} /> {t('cfields.addOption')}
              </Button>
            </div>
            {options.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">{t('cfields.noOptions')}</p>
            ) : (
              <div className="space-y-1.5">
                {options.map((o, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <Input
                      value={o.label} placeholder={t('settings.fieldLabel')}
                      onChange={(e) => setOptions((prev) => prev.map((x, j) => j === i ? { ...x, label: e.target.value } : x))}
                      className="flex-1"
                    />
                    <Input
                      value={o.value} placeholder={slug(o.label) || t('cfields.optionValue')}
                      onChange={(e) => setOptions((prev) => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))}
                      className="w-36 font-mono text-xs"
                    />
                    <IconButton
                      size="sm" aria-label={t('common.delete')}
                      onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                    ><X size={13} /></IconButton>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-muted-foreground">{t('cfields.optionsHint')}</p>
          </div>
        )}

        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('settings.required')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('cfields.requiredHint')}</div>
            </div>
            <Switch checked={required} onChange={setRequired} />
          </div>
          <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5">
            <div className="min-w-0"><div className="text-[13px] font-medium">{t('cfields.showInList')}</div></div>
            <Switch checked={showInList} onChange={setShowInList} />
          </div>
          <div className="flex items-center justify-between gap-4 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('cfields.sortable')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('cfields.sortableHint')}</div>
            </div>
            <Switch checked={isSortable} onChange={setIsSortable} />
          </div>
        </div>

        <Disclosure label={t('cfields.advanced')} defaultOpen={indexed || deprecated}>
          <div className="space-y-3 pt-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{t('cfields.indexed')}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{t('cfields.indexedHint')}</div>
              </div>
              {/* The index is created eagerly server-side; unchecking would not drop it, so don't pretend. */}
              <Switch checked={indexed} onChange={setIndexed} disabled={!!field?.indexed} />
            </div>
            {field && (
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">{t('cfields.deprecated')}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t('cfields.deprecatedHint')}</div>
                </div>
                <Switch checked={deprecated} onChange={setDeprecated} />
              </div>
            )}
          </div>
        </Disclosure>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!valid || save.isPending}>
            {save.isPending ? <Spinner /> : null} {field ? t('common.save') : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
