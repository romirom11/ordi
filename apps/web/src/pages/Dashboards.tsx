import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useNavigate } from '../lib/router';
import { Button, Input, Select, Card, Badge, PageHeader, EmptyState, Skeleton, cn } from '../components/ui';
import { ChevronLeft, LayoutDashboard, Lock, Plus, Trash2, Users } from 'lucide-react';
import { useT } from '../lib/i18n';

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
      if (d?.id) navigate('/dashboards/' + d.id);
    },
  });

  const dashboards = list.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title={t('nav.dashboards')}
        subtitle={t('dashboards.subtitle')}
        actions={<Button size="sm" onClick={() => setShowForm((s) => !s)}><Plus size={14} /> {t('dashboards.newDashboard')}</Button>}
      />
      <div className="p-6">
        {showForm && (
          <Card className="mb-4 max-w-lg p-4">
            <form
              className="flex items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) create.mutate();
              }}
            >
              <label className="flex-1 text-xs text-muted-foreground">
                {t('common.name')}
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('dashboards.namePlaceholder')} className="mt-1" autoFocus />
              </label>
              <label className="text-xs text-muted-foreground">
                {t('dashboards.visibility')}
                <Select value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'workspace')} className="mt-1 block">
                  <option value="private">{t('dashboards.private')}</option>
                  <option value="workspace">{t('dashboards.workspace')}</option>
                </Select>
              </label>
              <Button type="submit" disabled={create.isPending || !name.trim()}>{t('common.create')}</Button>
            </form>
            {create.isError && <p className="mt-2 text-xs text-destructive">{t('dashboards.createFailed')}</p>}
          </Card>
        )}

        {list.isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 w-full" />)}
          </div>
        ) : list.isError ? (
          <p className="text-sm text-destructive">{t('dashboards.loadFailed')}</p>
        ) : dashboards.length === 0 ? (
          <EmptyState
            title={t('dashboards.empty')}
            hint={t('dashboards.emptyHint')}
            action={<Button size="sm" onClick={() => setShowForm(true)}><Plus size={14} /> {t('dashboards.newDashboard')}</Button>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dashboards.map((d) => (
              <button
                key={d.id}
                className="text-left"
                onClick={() => navigate('/dashboards/' + d.id)}
              >
                <Card className="flex h-24 flex-col justify-between p-4 transition-colors hover:bg-muted/50">
                  <div className="flex items-center gap-2 font-medium">
                    <LayoutDashboard size={15} className="text-muted-foreground" />
                    <span className="truncate">{d.name}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    {d.visibility === 'workspace' ? <Users size={12} /> : <Lock size={12} />}
                    {d.visibility === 'workspace' ? t('dashboards.workspace') : t('dashboards.private')}
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
    },
  });
  const deleteWidget = useMutation({
    mutationFn: (widgetId: string) => api.del(`/dashboards/${id}/widgets/${widgetId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard', id] }),
  });

  if (dash.isLoading) {
    return (
      <div>
        <PageHeader title={<Skeleton className="h-6 w-48" />} />
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
          <span className="flex items-center gap-2">
            <button className="rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => navigate('/dashboards')} title={t('dashboards.all')}>
              <ChevronLeft size={16} />
            </button>
            {dash.data.name}
          </span>
        }
        subtitle={dash.data.visibility === 'workspace' ? t('dashboards.visibleToWorkspace') : t('dashboards.private')}
        actions={<Button size="sm" onClick={() => setShowAdd((s) => !s)}><Plus size={14} /> {t('dashboards.addWidget')}</Button>}
      />
      <div className="p-6">
        {showAdd && (
          <Card className="mb-4 max-w-3xl p-4">
            <div className="mb-3 text-sm font-medium">{t('dashboards.addWidget')}</div>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                addWidget.mutate();
              }}
            >
              <label className="text-xs text-muted-foreground">
                {t('dashboards.type')}
                <Select value={wForm.widgetType} onChange={(e) => setWForm((f) => ({ ...f, widgetType: e.target.value }))} className="mt-1 block">
                  <option value="bar">{t('dashboards.typeBar')}</option>
                  <option value="line">{t('dashboards.typeLine')}</option>
                  <option value="pie">{t('dashboards.typePie')}</option>
                  <option value="number">{t('dashboards.typeNumber')}</option>
                  <option value="table">{t('dashboards.typeTable')}</option>
                </Select>
              </label>
              <label className="text-xs text-muted-foreground">
                {t('dashboards.source')}
                <Select value={wForm.source} onChange={(e) => setWForm((f) => ({ ...f, source: e.target.value }))} className="mt-1 block">
                  <option value="tasks">{t('common.tasks')}</option>
                  <option value="invoices">{t('finance.invoices')}</option>
                  <option value="deals">{t('nav.deals')}</option>
                </Select>
              </label>
              <label className="text-xs text-muted-foreground">
                {t('time.groupBy')}
                <Input
                  value={wForm.groupBy}
                  onChange={(e) => setWForm((f) => ({ ...f, groupBy: e.target.value }))}
                  placeholder="status / priority / assignee"
                  className="mt-1 w-48"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                {t('dashboards.metric')}
                <Select value={wForm.metric} onChange={(e) => setWForm((f) => ({ ...f, metric: e.target.value }))} className="mt-1 block">
                  <option value="count">{t('dashboards.metricCount')}</option>
                  <option value="sum_amount">{t('dashboards.metricSumAmount')}</option>
                  <option value="sum_estimate">{t('dashboards.metricSumEstimate')}</option>
                </Select>
              </label>
              <Button type="submit" disabled={addWidget.isPending}>{t('common.add')}</Button>
            </form>
            {addWidget.isError && <p className="mt-2 text-xs text-destructive">{t('dashboards.addWidgetFailed')}</p>}
          </Card>
        )}

        {widgets.length === 0 ? (
          <EmptyState
            title={t('dashboards.noWidgets')}
            hint={t('dashboards.noWidgetsHint')}
            action={<Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} /> {t('dashboards.addWidget')}</Button>}
          />
        ) : (
          <div className="grid grid-cols-12 gap-3">
            {widgets.map((w) => (
              <WidgetCard key={w.id} dashboardId={id} widget={w} onDelete={() => deleteWidget.mutate(w.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WidgetCard({ dashboardId, widget, onDelete }: { dashboardId: string; widget: Widget; onDelete: () => void }) {
  const t = useT();
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
    key: p.key != null && p.key !== '' ? String(p.key) : '—',
    value: Number(p.value ?? 0),
  }));
  const forbidden = (data.data as { forbidden?: boolean } | undefined)?.forbidden === true;

  return (
    <div style={{ gridColumn: `span ${w}`, minHeight: h * 80 }}>
      <Card className="flex h-full flex-col p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium capitalize">{title}</span>
        <div className="flex items-center gap-1.5">
          <Badge className="bg-muted uppercase text-muted-foreground">{widget.widgetType}</Badge>
          <button className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive" title={t('dashboards.deleteWidget')} onClick={onDelete}>
            <Trash2 size={13} />
          </button>
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
    </div>
  );
}

function WidgetBody({ type, points }: { type: string; points: { key: string; value: number }[] }) {
  if (type === 'number') {
    const total = points.reduce((a, p) => a + p.value, 0);
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-4xl font-semibold tabular-nums">{Number.isInteger(total) ? total : total.toFixed(2)}</span>
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
    <div className="space-y-1.5">
      {points.map((p, i) => (
        <div key={p.key + i} className="flex items-center gap-2 text-xs">
          <span className="w-24 shrink-0 truncate text-muted-foreground" title={p.key}>{p.key}</span>
          <div className="h-4 flex-1 rounded-sm bg-muted/50">
            <div
              className="h-full rounded-sm"
              style={{ width: `${Math.max((p.value / max) * 100, 1)}%`, backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
            />
          </div>
          <span className="w-12 text-right tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
}
