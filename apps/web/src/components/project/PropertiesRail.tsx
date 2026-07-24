import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Rocket, Target } from 'lucide-react';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import {
  ProgressBar, ProgressRing, Skeleton, StatusIcon, cn,
} from '../ui';
import { projectColor } from './ProjectIcon';
import {
  RailField, LeadPicker, DateRailPicker, ProjectStatusPicker, VisibilityPicker, CompanyPicker,
  type UserLite, type CompanyLite, type ProjectStatus,
} from './pickers';
import { useT } from '../../lib/i18n';

interface ProjectLite {
  id: string; key: string; status: string; leadId?: string | null;
  startDate?: string | null; targetDate?: string | null; visibility?: string;
  companyId?: string | null; companyName?: string | null;
}
interface StatusLite { id: string; name: string; category?: string; color?: string }
interface TaskLite { statusId: string }

/** Right column of the Overview tab: completion stats + editable properties. */
export function PropertiesRail({ project, statuses, tasks, tasksLoading, users, canWrite, onPatch }: {
  project: ProjectLite;
  statuses: StatusLite[];
  tasks: TaskLite[];
  tasksLoading: boolean;
  users: UserLite[];
  canWrite: boolean;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const can = useCan();

  const companiesQ = useQuery<CompanyLite[]>({
    queryKey: ['companies', 'lookup'],
    queryFn: () => api.get<{ data: CompanyLite[] }>('/companies').then((r) => r.data),
    enabled: canWrite,
    staleTime: 5 * 60_000,
  });
  const companies = companiesQ.data ?? [];

  const catOf = (sid: string) => statuses.find((s) => s.id === sid)?.category;
  const total = tasks.length;
  const done = tasks.filter((x) => catOf(x.statusId) === 'done').length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const accent = projectColor(project.key || project.id);
  const perStatus = useMemo(
    () => statuses.map((s) => ({ s, n: tasks.filter((x) => x.statusId === s.id).length })),
    [statuses, tasks],
  );

  return (
    <div className="space-y-5">
      {/* Completion stat block */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-3.5">
          <div className="relative grid shrink-0 place-items-center">
            <ProgressRing value={pct} size={60} stroke={5} color={pct === 100 ? '#22c55e' : accent} />
            <span className="absolute text-[13px] font-semibold tabular-nums">{pct}%</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">{t('projects.completion')}</p>
            {tasksLoading ? (
              <Skeleton className="mt-1 h-5 w-20" />
            ) : (
              <p className="text-sm">
                <span className="text-base font-semibold tabular-nums">{done}</span>
                <span className="text-muted-foreground"> / {total} {t('projects.done').toLowerCase()}</span>
              </p>
            )}
          </div>
        </div>

        {total > 0 && (
          <div className="mt-3.5 space-y-2 border-t border-border pt-3.5">
            {perStatus.filter(({ n }) => n > 0).map(({ s, n }) => (
              <div key={s.id}>
                <div className="mb-1 flex items-center gap-1.5 text-xs">
                  <StatusIcon category={s.category} color={s.color} size={12} />
                  <span className="flex-1 truncate text-muted-foreground">{s.name}</span>
                  <span className="tabular-nums text-muted-foreground">{n}</span>
                </div>
                <ProgressBar value={total > 0 ? (n / total) * 100 : 0} color={s.color} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Properties */}
      <div className={cn('space-y-0.5')}>
        <p className="px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('projects.properties')}</p>
        <RailField label={t('common.status')}>
          <ProjectStatusPicker value={project.status} disabled={!canWrite} onSelect={(s: ProjectStatus) => onPatch({ status: s })} />
        </RailField>
        <RailField label={t('projects.lead')}>
          <LeadPicker value={project.leadId} users={users} disabled={!canWrite} onSelect={(uid) => onPatch({ leadId: uid })} />
        </RailField>
        <RailField label={t('projects.startDate')}>
          <DateRailPicker value={project.startDate} disabled={!canWrite} placeholder={t('projects.setStart')}
            icon={<Rocket size={14} className="text-faint" />} onChange={(v) => onPatch({ startDate: v })} />
        </RailField>
        <RailField label={t('projects.targetDate')}>
          <DateRailPicker value={project.targetDate} disabled={!canWrite} placeholder={t('projects.setTarget')}
            icon={<Target size={14} className="text-faint" />} onChange={(v) => onPatch({ targetDate: v })} />
        </RailField>
        <RailField label={t('projects.company')}>
          <CompanyPicker value={project.companyId} companyName={project.companyName} companies={companies}
            disabled={!canWrite} onSelect={(cid) => onPatch({ companyId: cid })} />
        </RailField>
        <RailField label={t('projects.visibility')}>
          <VisibilityPicker value={project.visibility} disabled={!can('projects.write')}
            onSelect={(v) => onPatch({ visibility: v })} />
        </RailField>
      </div>
    </div>
  );
}
