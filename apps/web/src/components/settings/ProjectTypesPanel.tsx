/**
 * Settings → Project types: fully user-configurable project types.
 * Each type carries two behaviours consumed by the API – "requires client"
 * (project must link a company) and "revenue source" (invoice eligibility +
 * profitability revenue).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, FolderKanban, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Badge, Button, IconButton, Input, Select, Spinner, Switch, Skeleton, EmptyState, cn } from '../ui';
import { Dialog, ConfirmDialog, toast } from '../overlays';
import { SectionHead, Field, RowList, AnimatedRow } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.projectTypes': 'Project types',
    'settings.projectTypesDesc': 'Define your own project types and how each behaves – client link and revenue.',
    'ptypes.new': 'New type',
    'ptypes.edit': 'Edit type',
    'ptypes.icon': 'Icon',
    'ptypes.color': 'Color',
    'ptypes.requiresClient': 'Requires client',
    'ptypes.requiresClientHint': 'Projects of this type must be linked to a client company.',
    'ptypes.revenue': 'Revenue',
    'ptypes.revenue.client_billing': 'Client billing',
    'ptypes.revenue.none': 'No revenue',
    'ptypes.revenue.direct': 'Direct',
    'ptypes.revenueHint.client_billing': 'Revenue comes from invoices billed to the client.',
    'ptypes.revenueHint.none': 'Pure cost – projects of this type never earn revenue.',
    'ptypes.revenueHint.direct': 'Income is recorded directly (e.g. product sales) – ledger support coming.',
    'ptypes.default': 'Default',
    'ptypes.defaultHint': 'Preselected in the new-project dialog.',
    'ptypes.deleteTitle': 'Delete project type',
    'ptypes.deleteConfirm': 'Delete this project type? Projects using it must be moved first.',
    'ptypes.moveUp': 'Move up',
    'ptypes.moveDown': 'Move down',
    'ptypes.empty': 'No project types yet',
    'ptypes.emptyHint': 'Create a type to classify your projects.',
  },
  uk: {
    'settings.projectTypes': 'Типи проєктів',
    'settings.projectTypesDesc': 'Визначте власні типи проєктів та їхню поведінку – звʼязок із клієнтом і дохід.',
    'ptypes.new': 'Новий тип',
    'ptypes.edit': 'Редагувати тип',
    'ptypes.icon': 'Іконка',
    'ptypes.color': 'Колір',
    'ptypes.requiresClient': 'Потребує клієнта',
    'ptypes.requiresClientHint': 'Проєкти цього типу мають бути привʼязані до компанії-клієнта.',
    'ptypes.revenue': 'Дохід',
    'ptypes.revenue.client_billing': 'Рахунки клієнту',
    'ptypes.revenue.none': 'Без доходу',
    'ptypes.revenue.direct': 'Прямий',
    'ptypes.revenueHint.client_billing': 'Дохід – з рахунків, виставлених клієнту.',
    'ptypes.revenueHint.none': 'Лише витрати – проєкти цього типу не приносять доходу.',
    'ptypes.revenueHint.direct': 'Дохід фіксується напряму (напр., продажі продукту) – журнал доходів згодом.',
    'ptypes.default': 'За замовчуванням',
    'ptypes.defaultHint': 'Обирається автоматично в діалозі нового проєкту.',
    'ptypes.deleteTitle': 'Видалити тип проєкту',
    'ptypes.deleteConfirm': 'Видалити цей тип проєкту? Спершу перенесіть проєкти, що його використовують.',
    'ptypes.moveUp': 'Перемістити вгору',
    'ptypes.moveDown': 'Перемістити вниз',
    'ptypes.empty': 'Ще немає типів проєктів',
    'ptypes.emptyHint': 'Створіть тип, щоб класифікувати проєкти.',
  },
});

export interface ProjectType {
  id: string; name: string; icon?: string; color?: string;
  requiresClient?: boolean; revenueSource?: string; isDefault?: boolean; position?: number;
}

const REVENUE_OPTIONS = ['client_billing', 'none', 'direct'] as const;
const COLORS = ['#6366f1', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#ec4899', '#64748b'];

export function ProjectTypesPanel() {
  const t = useT();
  const qc = useQueryClient();
  const typesQ = useQuery<ProjectType[]>({
    queryKey: ['project-types'],
    queryFn: () => api.get<{ data: ProjectType[] }>('/project-types').then((r) => r.data),
  });
  const types = typesQ.data ?? [];
  const [editing, setEditing] = useState<ProjectType | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<ProjectType | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['project-types'] });
  const apiError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed'));

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.patch('/project-types/order', { ids }),
    onSuccess: invalidate,
    onError: apiError,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/project-types/${id}`),
    onSuccess: () => { setDeleting(null); invalidate(); toast(t('common.saved')); },
    onError: (e) => { setDeleting(null); apiError(e); },
  });

  const move = (idx: number, dir: -1 | 1) => {
    const ids = types.map((x) => x.id);
    const target = idx + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[idx], ids[target]] = [ids[target]!, ids[idx]!];
    reorder.mutate(ids);
  };

  return (
    <div>
      <SectionHead
        title={t('settings.projectTypes')}
        desc={t('settings.projectTypesDesc')}
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> {t('ptypes.new')}</Button>}
      />

      {typesQ.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : types.length === 0 ? (
        <EmptyState icon={<FolderKanban size={18} />} title={t('ptypes.empty')} hint={t('ptypes.emptyHint')} />
      ) : (
        <RowList>
          {types.map((pt, i) => (
            <AnimatedRow key={pt.id} index={i} className="group flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: pt.color ?? '#8a8f98' }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{pt.name}</span>
                  {pt.isDefault && <Badge className="bg-primary/10 text-primary">{t('ptypes.default')}</Badge>}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  {pt.requiresClient && <span>{t('ptypes.requiresClient')}</span>}
                  {pt.requiresClient && <span className="text-faint">·</span>}
                  <span>{t(`ptypes.revenue.${pt.revenueSource ?? 'client_billing'}`)}</span>
                  {pt.icon && <span className="font-mono text-[10px] text-faint">{pt.icon}</span>}
                </div>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                <IconButton size="sm" aria-label={t('ptypes.moveUp')} onClick={() => move(i, -1)} disabled={i === 0 || reorder.isPending}><ArrowUp size={14} /></IconButton>
                <IconButton size="sm" aria-label={t('ptypes.moveDown')} onClick={() => move(i, 1)} disabled={i === types.length - 1 || reorder.isPending}><ArrowDown size={14} /></IconButton>
                <IconButton size="sm" aria-label={t('ptypes.edit')} onClick={() => setEditing(pt)}><Pencil size={14} /></IconButton>
                <IconButton size="sm" aria-label={t('common.delete')} className="text-destructive" onClick={() => setDeleting(pt)}><Trash2 size={14} /></IconButton>
              </div>
            </AnimatedRow>
          ))}
        </RowList>
      )}

      <TypeDialog
        open={createOpen || !!editing}
        type={editing}
        nextPosition={types.reduce((m, x) => Math.max(m, (x.position ?? 0) + 1), 0)}
        onClose={() => { setCreateOpen(false); setEditing(null); }}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) del.mutate(deleting.id); }}
        title={t('ptypes.deleteTitle')}
        body={t('ptypes.deleteConfirm')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}

function TypeDialog({ open, type, nextPosition, onClose }: { open: boolean; type: ProjectType | null; nextPosition: number; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('folder');
  const [color, setColor] = useState(COLORS[0]!);
  const [requiresClient, setRequiresClient] = useState(false);
  const [revenueSource, setRevenueSource] = useState<string>('client_billing');
  const [isDefault, setIsDefault] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(type?.name ?? '');
    setIcon(type?.icon ?? 'folder');
    setColor(type?.color ?? COLORS[0]!);
    setRequiresClient(type?.requiresClient ?? false);
    setRevenueSource(type?.revenueSource ?? 'client_billing');
    setIsDefault(type?.isDefault ?? false);
  }, [open, type]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), icon: icon.trim() || 'folder', color, requiresClient, revenueSource, isDefault };
      return type
        ? api.patch(`/project-types/${type.id}`, body)
        : api.post('/project-types', { ...body, position: nextPosition });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project-types'] }); toast(t('common.saved')); onClose(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={type ? t('ptypes.edit') : t('ptypes.new')} width={440}>
      <form
        className="space-y-3.5 px-4 pb-4 pt-1"
        onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) save.mutate(); }}
      >
        <Field label={t('common.name')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="SaaS product" />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('ptypes.color')}>
            <div className="flex h-8 items-center gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => setColor(c)}
                  className={cn(
                    'h-5 w-5 rounded-full transition-transform duration-150',
                    color === c ? 'scale-110 ring-2 ring-ring ring-offset-2 ring-offset-elevated' : 'hover:scale-110',
                  )}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
          </Field>
          <Field label={t('ptypes.icon')}>
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="folder" className="font-mono text-xs" />
          </Field>
        </div>

        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('ptypes.requiresClient')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('ptypes.requiresClientHint')}</div>
            </div>
            <Switch checked={requiresClient} onChange={setRequiresClient} />
          </div>
          <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('ptypes.revenue')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t(`ptypes.revenueHint.${revenueSource}`)}</div>
            </div>
            <Select value={revenueSource} onChange={(e) => setRevenueSource(e.target.value)} className="w-40">
              {REVENUE_OPTIONS.map((r) => <option key={r} value={r}>{t(`ptypes.revenue.${r}`)}</option>)}
            </Select>
          </div>
          <div className="flex items-center justify-between gap-4 px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('ptypes.default')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('ptypes.defaultHint')}</div>
            </div>
            <Switch checked={isDefault} onChange={setIsDefault} />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!name.trim() || save.isPending}>
            {save.isPending ? <Spinner /> : null} {type ? t('common.save') : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
