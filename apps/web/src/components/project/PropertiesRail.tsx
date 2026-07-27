import { useQuery } from '@tanstack/react-query';
import { Rocket, Tag, Target } from 'lucide-react';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { useLabels, type LabelLookup } from '../../lib/queries';
import { PriorityIcon, cn } from '../ui';
import { DropdownMenu, MenuItem, MenuLabel } from '../overlays';
import { LabelsMenu } from '../LabelsMenu';
import { MembersRailPicker } from './MembersRail';
import {
  RailField, LeadPicker, DateRailPicker, ProjectStatusPicker, VisibilityPicker, CompanyPicker,
  type UserLite, type CompanyLite, type ProjectStatus,
} from './pickers';
import { ProjectProgressPanel } from './ProjectProgress';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'projects.type': 'Type',
    'projects.priority': 'Priority',
    'projects.priorityNone': 'No priority',
    'projects.priorityLow': 'Low',
    'projects.priorityMedium': 'Medium',
    'projects.priorityHigh': 'High',
    'projects.priorityUrgent': 'Urgent',
    'projects.labels': 'Labels',
    'projects.addLabels': 'Add labels',
    'projects.members': 'Members',
    'projects.manageMembers': 'Manage members',
  },
  uk: {
    'projects.type': 'Тип',
    'projects.priority': 'Пріоритет',
    'projects.priorityNone': 'Без пріоритету',
    'projects.priorityLow': 'Низький',
    'projects.priorityMedium': 'Середній',
    'projects.priorityHigh': 'Високий',
    'projects.priorityUrgent': 'Терміновий',
    'projects.labels': 'Мітки',
    'projects.addLabels': 'Додати мітки',
    'projects.members': 'Учасники',
    'projects.manageMembers': 'Керувати учасниками',
  },
});

interface ProjectLite {
  id: string; key: string; status: string; leadId?: string | null;
  startDate?: string | null; targetDate?: string | null; visibility?: string;
  companyId?: string | null; companyName?: string | null; projectTypeId?: string | null;
  priority?: string; labelIds?: string[];
}
interface ProjectTypeLite { id: string; name: string; color?: string; requiresClient?: boolean }

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
const PRIORITY_KEY: Record<string, string> = {
  none: 'projects.priorityNone', low: 'projects.priorityLow', medium: 'projects.priorityMedium',
  high: 'projects.priorityHigh', urgent: 'projects.priorityUrgent',
};

/**
 * Right column of the Overview tab: editable properties (single source for
 * project metadata) plus the Progress panel with the burnup chart.
 */
export function PropertiesRail({ project, users, canWrite, canManageMembers, onPatch, onManageMembers }: {
  project: ProjectLite;
  users: UserLite[];
  canWrite: boolean;
  /** Project admins may edit membership straight from the rail. */
  canManageMembers: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onManageMembers?: () => void;
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
  const typesQ = useQuery<ProjectTypeLite[]>({
    queryKey: ['project-types'],
    queryFn: () => api.get<{ data: ProjectTypeLite[] }>('/project-types').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const projectTypes = typesQ.data ?? [];
  return (
    <div className="space-y-5">
      {/* Properties */}
      <div className="space-y-0.5">
        <p className="px-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('projects.properties')}</p>
        <RailField label={t('common.status')}>
          <ProjectStatusPicker value={project.status} disabled={!canWrite} onSelect={(s: ProjectStatus) => onPatch({ status: s })} />
        </RailField>
        <RailField label={t('projects.priority')}>
          <PriorityRailPicker value={project.priority ?? 'none'} disabled={!canWrite} onSelect={(p) => onPatch({ priority: p })} />
        </RailField>
        <RailField label={t('projects.lead')}>
          <LeadPicker value={project.leadId} users={users} disabled={!canWrite} onSelect={(uid) => onPatch({ leadId: uid })} />
        </RailField>
        <RailField label={t('projects.members')}>
          <MembersRailPicker projectId={project.id} canManage={canManageMembers} onManageAll={onManageMembers} />
        </RailField>
        <RailField label={t('projects.startDate')}>
          <DateRailPicker value={project.startDate} disabled={!canWrite} placeholder={t('projects.setStart')}
            icon={<Rocket size={14} className="text-faint" />} onChange={(v) => onPatch({ startDate: v })} />
        </RailField>
        <RailField label={t('projects.targetDate')}>
          <DateRailPicker value={project.targetDate} disabled={!canWrite} placeholder={t('projects.setTarget')}
            icon={<Target size={14} className="text-faint" />} onChange={(v) => onPatch({ targetDate: v })} />
        </RailField>
        <RailField label={t('projects.type')}>
          <ProjectTypeRailPicker
            value={project.projectTypeId}
            types={projectTypes}
            disabled={!can('projects.write')}
            onSelect={(tid) => onPatch({ projectTypeId: tid })}
          />
        </RailField>
        <RailField label={t('projects.company')}>
          <CompanyPicker value={project.companyId} companyName={project.companyName} companies={companies}
            disabled={!canWrite} onSelect={(cid) => onPatch({ companyId: cid })} />
        </RailField>
        <RailField label={t('projects.visibility')}>
          <VisibilityPicker value={project.visibility} disabled={!can('projects.write')}
            onSelect={(v) => onPatch({ visibility: v })} />
        </RailField>
        <RailField label={t('projects.labels')}>
          <LabelsRailPicker
            value={project.labelIds ?? []}
            disabled={!canWrite}
            onChange={(ids) => onPatch({ labelIds: ids })}
          />
        </RailField>
      </div>

      {/* Progress (scope / started / completed + burnup) */}
      <ProjectProgressPanel projectId={project.id} />
    </div>
  );
}

/** Priority chip + dropdown, Linear-style glyphs. */
function PriorityRailPicker({ value, onSelect, disabled }: {
  value: string; onSelect: (p: string) => void; disabled?: boolean;
}) {
  const t = useT();
  const trigger = (
    <span className={cn(
      'group flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] transition-colors duration-150',
      disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted',
      value === 'none' && 'text-muted-foreground',
    )}>
      <PriorityIcon priority={value} size={15} />
      <span className="truncate">{t(PRIORITY_KEY[value] ?? PRIORITY_KEY.none!)}</span>
    </span>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={190} className="w-full">
      <MenuLabel>{t('projects.priority')}</MenuLabel>
      {PRIORITIES.map((p) => (
        <MenuItem
          key={p}
          checked={value === p}
          icon={<PriorityIcon priority={p} size={15} />}
          onSelect={() => { if (p !== value) onSelect(p); }}
        >
          {t(PRIORITY_KEY[p]!)}
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}

/** Multi-select label chips + the shared picker, scoped to project labels. */
function LabelsRailPicker({ value, onChange, disabled }: {
  value: string[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const t = useT();
  const labels = useLabels('project').data ?? [];
  const selected = value.map((id) => labels.find((l) => l.id === id)).filter((l): l is LabelLookup => !!l);
  const trigger = (
    <span className={cn(
      'group flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-[13px] transition-colors duration-150',
      disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted',
      selected.length === 0 && 'text-faint',
    )}>
      {selected.length === 0 ? (
        <><Tag size={14} className="text-faint" /><span className="truncate">{disabled ? '–' : t('projects.addLabels')}</span></>
      ) : selected.map((l) => (
        <span key={l.id} className="inline-flex h-[18px] items-center gap-1 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color ?? '#8a8f98' }} />
          {l.name}
        </span>
      ))}
    </span>
  );
  if (disabled) return trigger;

  return (
    <DropdownMenu trigger={trigger} align="start" width={240} className="w-full">
      <LabelsMenu scope="project" value={value} onChange={onChange} />
    </DropdownMenu>
  );
}

/** Project type chip + dropdown (admins only) – mirrors the other rail pickers. */
function ProjectTypeRailPicker({ value, types, onSelect, disabled }: {
  value?: string | null; types: ProjectTypeLite[]; onSelect: (id: string) => void; disabled?: boolean;
}) {
  const t = useT();
  const current = value ? types.find((x) => x.id === value) : undefined;
  const trigger = (
    <span className={cn(
      'group flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] transition-colors duration-150',
      disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted',
      !current && 'text-faint',
    )}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: current?.color ?? '#8a8f98' }} />
      <span className="truncate">{current?.name ?? '–'}</span>
    </span>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={210} className="w-full">
      <MenuLabel>{t('projects.type')}</MenuLabel>
      {types.map((pt) => (
        <MenuItem
          key={pt.id}
          checked={value === pt.id}
          icon={<span className="h-2 w-2 rounded-full" style={{ backgroundColor: pt.color ?? '#8a8f98' }} />}
          onSelect={() => { if (pt.id !== value) onSelect(pt.id); }}
        >
          {pt.name}
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}
