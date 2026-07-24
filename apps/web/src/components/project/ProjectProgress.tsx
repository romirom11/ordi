/**
 * Progress panel for the project overview rail: Scope / Started / Completed
 * numbers plus a compact hand-rolled SVG burnup chart (three series, no chart
 * library), Linear-style.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Skeleton, fmtDate, cn } from '../ui';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'projects.progressPanel': 'Progress',
    'projects.scope': 'Scope',
    'projects.started': 'Started',
    'projects.completed': 'Completed',
  },
  uk: {
    'projects.progressPanel': 'Прогрес',
    'projects.scope': 'Обсяг',
    'projects.started': 'В роботі',
    'projects.completed': 'Виконано',
  },
});

export interface ProgressPoint { date: string; scope: number; started: number; completed: number }
export interface ProjectProgressData { scope: number; started: number; completed: number; series: ProgressPoint[] }

const COLORS = {
  scope: '#8a8f98',
  started: '#f2c94c',
  completed: '#5e6ad2',
} as const;

function pct(part: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

/** Build an SVG polyline path for one series. */
function linePath(values: number[], w: number, h: number, max: number, pad: number): string {
  const n = values.length;
  const stepX = n > 1 ? (w - pad * 2) / (n - 1) : 0;
  const y = (v: number) => h - pad - (max > 0 ? (v / max) * (h - pad * 2) : 0);
  return values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(pad + i * stepX).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
}

function areaPath(values: number[], w: number, h: number, max: number, pad: number): string {
  const n = values.length;
  const stepX = n > 1 ? (w - pad * 2) / (n - 1) : 0;
  const lastX = pad + (n - 1) * stepX;
  return `${linePath(values, w, h, max, pad)} L${lastX.toFixed(2)},${(h - pad).toFixed(2)} L${pad},${(h - pad).toFixed(2)} Z`;
}

export function BurnupChart({ series, className }: { series: ProgressPoint[]; className?: string }) {
  // A single point still draws a flat line across the chart.
  const pts = series.length === 1 ? [series[0]!, series[0]!] : series;
  if (pts.length === 0) return null;
  const W = 240; const H = 84; const PAD = 4;
  const max = Math.max(1, ...pts.map((p) => p.scope));
  const scope = pts.map((p) => p.scope);
  const started = pts.map((p) => p.started);
  const completed = pts.map((p) => p.completed);
  return (
    <div className={className}>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden>
        {/* baseline */}
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="currentColor" strokeOpacity="0.15" strokeWidth="1" />
        <path d={areaPath(scope, W, H, max, PAD)} fill={COLORS.scope} fillOpacity="0.07" />
        <path d={areaPath(started, W, H, max, PAD)} fill={COLORS.started} fillOpacity="0.10" />
        <path d={areaPath(completed, W, H, max, PAD)} fill={COLORS.completed} fillOpacity="0.16" />
        <path d={linePath(scope, W, H, max, PAD)} fill="none" stroke={COLORS.scope} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={linePath(started, W, H, max, PAD)} fill="none" stroke={COLORS.started} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        <path d={linePath(completed, W, H, max, PAD)} fill="none" stroke={COLORS.completed} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-faint">
        <span>{fmtDate(pts[0]!.date)}</span>
        <span>{fmtDate(pts[pts.length - 1]!.date)}</span>
      </div>
    </div>
  );
}

function StatRow({ color, label, value, share, dashed }: {
  color: string; label: string; value: number; share: string; dashed?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      <span
        className={cn('h-2.5 w-2.5 shrink-0 rounded-full', dashed && 'border border-current bg-transparent')}
        style={dashed ? { color } : { backgroundColor: color }}
      />
      <span className="flex-1 truncate text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
      <span className="w-9 text-right text-xs tabular-nums text-faint">{share}</span>
    </div>
  );
}

export function ProjectProgressPanel({ projectId }: { projectId: string }) {
  const t = useT();
  const { data, isLoading } = useQuery<ProjectProgressData>({
    queryKey: ['project-progress', projectId],
    queryFn: () => api.get<ProjectProgressData>(`/projects/${projectId}/progress`),
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-3.5">
        <Skeleton className="mb-3 h-4 w-20" />
        <Skeleton className="mb-2 h-4" />
        <Skeleton className="mb-2 h-4" />
        <Skeleton className="h-20" />
      </div>
    );
  }
  if (!data) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('projects.progressPanel')}</p>
      <div className="space-y-1.5">
        <StatRow color={COLORS.scope} label={t('projects.scope')} value={data.scope} share="" dashed />
        <StatRow color={COLORS.started} label={t('projects.started')} value={data.started} share={pct(data.started, data.scope)} />
        <StatRow color={COLORS.completed} label={t('projects.completed')} value={data.completed} share={pct(data.completed, data.scope)} />
      </div>
      {data.series.length > 0 && data.scope > 0 && <BurnupChart series={data.series} className="mt-3" />}
    </div>
  );
}
