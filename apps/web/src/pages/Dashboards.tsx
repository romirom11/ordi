import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useNavigate } from '../lib/router';
import {
  Button, Input, Select, Card, Badge, IconButton, PageHeader, EmptyState, Skeleton, Spinner, ProgressBar, cn,
} from '../components/ui';
import { Dialog, ConfirmDialog, DropdownMenu, MenuItem, toast } from '../components/overlays';
import { ChevronLeft, LayoutGrid, Lock, MoreHorizontal, Plus, Trash2, Users } from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'dashboards.widgetsLabel': 'widgets',
    'dashboards.widget': 'widget',
    'dashboards.deleteWidgetBody': 'This widget and its configuration will be removed from the dashboard.',
    'dashboards.widgetDeleted': 'Widget deleted',
    'dashboards.widgetAdded': 'Widget added',
    'dashboards.dashboardCreated': 'Dashboard created',
  },
  uk: {
    'dashboards.widgetsLabel': 'віджетів',
    'dashboards.widget': 'віджет',
    'dashboards.deleteWidgetBody': 'Цей віджет і його налаштування буде видалено з дашборда.',
    'dashboards.widgetDeleted': 'Віджет видалено',
    'dashboards.widgetAdded': 'Віджет додано',
    'dashboards.dashboardCreated': 'Дашборд створено',
  },
});

interface DashboardSummary {
  id: string;
  name: string;
  visibility?: string;
}
interface WidgetLayout { x?: number; y?: number; w?: number; h?: number }
interface Widget {
  id: string;
  widgetType: string;
  source?: string;
  config?: any;
  layout?: WidgetLayout;
}
interface DashboardDetail extends DashboardSummary {
  widgets?: Widget[];
}
interface DataPoint { key?: string | null; value?: number | string | null }

const CHART_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#84cc16', '#f43f5e'];

export function DashboardsPage({ id }: { id?: string }) {
  return id ? <DashboardDetailView id={id} /> : <DashboardListView />;
}

/** Extra request per card (same pattern as ProjectProgress in Projects.tsx) – the list
 * endpoint doesn't include widgets, but the detail endpoint (shared cache key) does. */
function DashboardCardMeta({ id }: { id: string }) {
  const t = useT();
  const q = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => api.get<DashboardDetail>(`/dashboards/${id}`),
    staleTime: 30_000,
  });
  const n = q.data?.widgets?.length ?? 0;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <LayoutGrid size={12} />
      {q.isLoading ? '–' : `${n} ${t('dashboards.widgetsLabel')}`}
    </span>
  );
}

function DashboardListView() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ['dashboards'],
    queryFn: () => api.get<{ data: DashboardSummary[] }>('/dashboards'),
  });

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'private' | 'workspace'>('private');
  const create = useMutation({
    mutationFn: () => api.post<DashboardSummary>('/dashboards', { name, visibility }),
    onSuccess: (d) => {
      setName('');
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['dashboards'] });
      toast(t('dashboards.dashboardCreated'));
      if (d?.id) navigate('/dashboards/' + d.id);
    },
    onError: () => toast.error(t('dashboards.createFailed')),
  });

  const dashboards = list.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title={t('nav.dashboards')}
        subtitle={t('dashboards.subtitle')}
        actions={<Button size="sm" onClick={() => setShowForm(true)}><Plus size={14} /> {t('dashboards.newDashboard')}</Button>}
      />

      <Dialog open={showForm} onClose={() => setShowForm(false)} title={t('dashboards.newDashboard')} width={420}>
        <form
          className="space-y-3 px-4 pb-4 pt-1"
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}
        >
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('common.name')}</label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('dashboards.namePlaceholder')} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('dashboards.visibility')}</label>
            <Select value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'workspace')} className="w-full">
              <option value="private">{t('dashboards.private')}</option>
              <option value="workspace">{t('dashboards.workspace')}</option>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>{create.isPending ? <Spinner /> : t('common.create')}</Button>
          </div>
        </form>
      </Dialog>

      <div className="p-6">
        {list.isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
          </div>
        ) : list.isError ? (
          <EmptyState title={t('dashboards.loadFailed')} />
        ) : dashboards.length === 0 ? (
          <EmptyState
            icon={<LayoutGrid size={20} />}
            title={t('dashboards.empty')}
            hint={t('dashboards.emptyHint')}
            action={<Button size="sm" onClick={() => setShowForm(true)}><Plus size={14} /> {t('dashboards.newDashboard')}</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dashboards.map((d, i) => (
              <button
                key={d.id}
                className="row-enter text-left"
                style={{ ['--i' as string]: Math.min(i, 10) }}
                onClick={() => navigate('/dashboards/' + d.id)}
              >
                <Card className="flex h-28 flex-col justify-between p-4 transition-colors duration-150 hover:border-border-strong hover:bg-muted/40">
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <LayoutGrid size={16} />
                    </span>
                    <span className="min-w-0 truncate text-[13px] font-medium">{d.name}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <DashboardCardMeta id={d.id} />
                    <span className="inline-flex items-center gap-1">
                      {d.visibility === 'workspace' ? <Users size={12} /> : <Lock size={12} />}
                      {d.visibility === 'workspace' ? t('dashboards.workspace') : t('dashboards.private')}
                    </span>
                  </div>
                </Card>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DashboardDetailView({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const dash = useQuery({
    queryKey: ['dashboard', id],
    queryFn: () => api.get<DashboardDetail>(`/dashboards/${id}`),
  });

  const [showAdd, setShowAdd] = useState(false);
  const [wForm, setWForm] = useState({ widgetType: 'bar', source: 'tasks', groupBy: 'status', metric: 'count' });
  const addWidget = useMutation({
    mutationFn: () =>
      api.post(`/dashboards/${id}/widgets`, {
        widgetType: wForm.widgetType,
        source: wForm.source,
        config: { filters: {}, groupBy: wForm.groupBy, metric: wForm.metric },
        layout: { x: 0, y: 0, w: 4, h: 3 },
      }),
    onSuccess: () => {
      setShowAdd(false);
      qc.invalidateQueries({ queryKey: ['dashboard', id] });
      toast(t('dashboards.widgetAdded'));
    },
    onError: () => toast.error(t('dashboards.addWidgetFailed')),
  });
  const deleteWidget = useMutation({
    mutationFn: (widgetId: string) => api.del(`/dashboards/${id}/widgets/${widgetId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard', id] });
      toast(t('dashboards.widgetDeleted'));
    },
    onError: () => toast.error(t('dashboards.dataFailed')),
  });

  if (dash.isLoading) {
    return (
      <div>
        <PageHeader title={<Skeleton className="h-5 w-48" />} />
        <div className="grid grid-cols-12 gap-3 p-6">
          {[0, 1, 2].map((i) => (
            <div key={i} style={{ gridColumn: 'span 4' }}><Skeleton className="h-56 w-full" /></div>
          ))}
        </div>
      </div>
    );
  }
  if (dash.isError || !dash.data) {
    const status = dash.error instanceof ApiError ? dash.error.status : undefined;
    return (
      <div>
        <PageHeader title={t('nav.dashboard')} />
        <EmptyState
          icon={<LayoutGrid size={20} />}
          title={status === 403 ? t('dashboards.noAccess') : status === 404 ? t('dashboards.notFound') : t('dashboards.loadOneFailed')}
          action={<Button variant="outline" size="sm" onClick={() => navigate('/dashboards')}><ChevronLeft size={14} /> {t('dashboards.all')}</Button>}
        />
      </div>
    );
  }

  const widgets = dash.data.widgets ?? [];

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-1.5">
            <IconButton size="sm" onClick={() => navigate('/dashboards')} title={t('dashboards.all')}>
              <ChevronLeft size={16} />
            </IconButton>
            <span className="truncate">{dash.data.name}</span>
          </span>
        }
        subtitle={dash.data.visibility === 'workspace' ? t('dashboards.visibleToWorkspace') : t('dashboards.private')}
        actions={<Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} /> {t('dashboards.addWidget')}</Button>}
      />

      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title={t('dashboards.addWidget')} width={560}>
        <form
          className="flex flex-wrap items-end gap-3 px-4 pb-4 pt-1"
          onSubmit={(e) => { e.preventDefault(); addWidget.mutate(); }}
        >
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('dashboards.type')}</label>
            <Select value={wForm.widgetType} onChange={(e) => setWForm((f) => ({ ...f, widgetType: e.target.value }))}>
              <option value="bar">{t('dashboards.typeBar')}</option>
              <option value="line">{t('dashboards.typeLine')}</option>
              <option value="pie">{t('dashboards.typePie')}</option>
              <option value="number">{t('dashboards.typeNumber')}</option>
              <option value="table">{t('dashboards.typeTable')}</option>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('dashboards.source')}</label>
            <Select value={wForm.source} onChange={(e) => setWForm((f) => ({ ...f, source: e.target.value }))}>
              <option value="tasks">{t('common.tasks')}</option>
              <option value="invoices">{t('finance.invoices')}</option>
              <option value="deals">{t('nav.deals')}</option>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('time.groupBy')}</label>
            <Input
              value={wForm.groupBy}
              onChange={(e) => setWForm((f) => ({ ...f, groupBy: e.target.value }))}
              placeholder="status / priority / assignee"
              className="w-44"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('dashboards.metric')}</label>
            <Select value={wForm.metric} onChange={(e) => setWForm((f) => ({ ...f, metric: e.target.value }))}>
              <option value="count">{t('dashboards.metricCount')}</option>
              <option value="sum_amount">{t('dashboards.metricSumAmount')}</option>
              <option value="sum_estimate">{t('dashboards.metricSumEstimate')}</option>
            </Select>
          </div>
          <div className="ml-auto flex gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={addWidget.isPending}>{addWidget.isPending ? <Spinner /> : t('common.add')}</Button>
          </div>
        </form>
      </Dialog>

      <div className="p-6">
        {widgets.length === 0 ? (
          <EmptyState
            icon={<LayoutGrid size={20} />}
            title={t('dashboards.noWidgets')}
            hint={t('dashboards.noWidgetsHint')}
            action={<Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} /> {t('dashboards.addWidget')}</Button>}
          />
        ) : (
          <div className="grid grid-cols-12 gap-3">
            {widgets.map((w, i) => (
              <WidgetCard
                key={w.id}
                dashboardId={id}
                widget={w}
                index={i}
                deleting={deleteWidget.isPending && deleteWidget.variables === w.id}
                onDelete={() => deleteWidget.mutate(w.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WidgetCard({ dashboardId, widget, index, deleting, onDelete }: {
  dashboardId: string; widget: Widget; index: number; deleting: boolean; onDelete: () => void;
}) {
  const t = useT();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const w = Math.min(Math.max(widget.layout?.w ?? 4, 2), 12);
  const h = widget.layout?.h ?? 3;
  const data = useQuery({
    queryKey: ['widgetData', dashboardId, widget.id],
    queryFn: async () => {
      try {
        return await api.get<{ data: DataPoint[] }>(`/dashboards/${dashboardId}/widgets/${widget.id}/data`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return { forbidden: true as const, data: [] as DataPoint[] };
        throw err;
      }
    },
  });

  const title = widget.config?.groupBy
    ? `${widget.source ?? ''} by ${widget.config.groupBy}`.trim()
    : widget.source ?? widget.widgetType;

  const points: { key: string; value: number }[] = (data.data?.data ?? []).map((p) => ({
    key: p.key != null && p.key !== '' ? String(p.key) : '–',
    value: Number(p.value ?? 0),
  }));
  const forbidden = (data.data as { forbidden?: boolean } | undefined)?.forbidden === true;

  return (
    <div className="row-enter" style={{ gridColumn: `span ${w}`, minHeight: h * 80, ['--i' as string]: Math.min(index, 10) }}>
      <Card className="flex h-full flex-col p-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium capitalize">{title}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge className="bg-muted text-[10px] uppercase tracking-wide text-muted-foreground">{widget.widgetType}</Badge>
            <DropdownMenu align="end" trigger={<IconButton size="sm" title={t('people.actions')}><MoreHorizontal size={14} /></IconButton>}>
              <MenuItem icon={<Trash2 size={13} />} danger onSelect={() => setConfirmOpen(true)}>{t('dashboards.deleteWidget')}</MenuItem>
            </DropdownMenu>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          {data.isLoading ? (
            <Skeleton className="h-full min-h-16 w-full" />
          ) : forbidden ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t('dashboards.widgetForbidden')}</p>
          ) : data.isError ? (
            <p className="py-4 text-center text-xs text-destructive">{t('dashboards.dataFailed')}</p>
          ) : points.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t('dashboards.noData')}</p>
          ) : (
            <WidgetBody type={widget.widgetType} points={points} />
          )}
        </div>
      </Card>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => { onDelete(); setConfirmOpen(false); }}
        title={t('dashboards.deleteWidget')}
        body={t('dashboards.deleteWidgetBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={deleting}
      />
    </div>
  );
}

function WidgetBody({ type, points }: { type: string; points: { key: string; value: number }[] }) {
  if (type === 'number') {
    const total = points.reduce((a, p) => a + p.value, 0);
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-4xl font-bold tabular-nums">{Number.isInteger(total) ? total : total.toFixed(2)}</span>
      </div>
    );
  }

  if (type === 'pie') {
    const total = points.reduce((a, p) => a + p.value, 0) || 1;
    return (
      <ul className="space-y-1.5">
        {points.map((p, i) => (
          <li key={p.key + i} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="min-w-0 flex-1 truncate">{p.key}</span>
            <span className="tabular-nums text-muted-foreground">{p.value}</span>
            <span className="w-10 text-right tabular-nums font-medium">{((p.value / total) * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    );
  }

  if (type === 'table') {
    return (
      <table className="w-full text-xs">
        <tbody>
          {points.map((p, i) => (
            <tr key={p.key + i} className={cn('border-border', i < points.length - 1 && 'border-b')}>
              <td className="py-1.5 pr-2">{p.key}</td>
              <td className="py-1.5 text-right tabular-nums">{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  // 'bar' and 'line' (line renders as bar fallback)
  const max = Math.max(...points.map((p) => p.value), 1);
  return (
    <div className="space-y-2">
      {points.map((p, i) => (
        <div key={p.key + i} className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 truncate text-muted-foreground" title={p.key}>{p.key}</span>
            <span className="shrink-0 tabular-nums font-medium">{p.value}</span>
          </div>
          <ProgressBar value={(p.value / max) * 100} color={CHART_COLORS[i % CHART_COLORS.length]} />
        </div>
      ))}
    </div>
  );
}
