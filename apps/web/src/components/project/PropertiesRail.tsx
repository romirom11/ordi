import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Rocket, Tag, Target } from 'lucide-react';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { PriorityIcon, Spinner, cn } from '../ui';
import { DropdownMenu, MenuItem, MenuLabel, toast } from '../overlays';
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
    'projects.searchLabels': 'Search or create a label',
    'projects.createLabel': 'Create label',
    'projects.labelCreated': 'Label created',
    'projects.labelCreateFailed': 'Could not create the label',
    'projects.noLabelsYet': 'No labels yet',
    'projects.noLabelMatches': 'No labels match',
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
    'projects.searchLabels': 'Знайти або створити мітку',
    'projects.createLabel': 'Створити мітку',
    'projects.labelCreated': 'Мітку створено',
    'projects.labelCreateFailed': 'Не вдалося створити мітку',
    'projects.noLabelsYet': 'Ще немає міток',
    'projects.noLabelMatches': 'Міток не знайдено',
  },
});

interface ProjectLite {
  id: string; key: string; status: string; leadId?: string | null;
  startDate?: string | null; targetDate?: string | null; visibility?: string;
  companyId?: string | null; companyName?: string | null; projectTypeId?: string | null;
  priority?: string; labelIds?: string[];
}
interface ProjectTypeLite { id: string; name: string; color?: string; requiresClient?: boolean }
interface LabelLite { id: string; name: string; color?: string | null }

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
  const labelsQ = useQuery<LabelLite[]>({
    queryKey: ['labels'],
    queryFn: () => api.get<{ data: LabelLite[] }>('/labels').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const labels = labelsQ.data ?? [];
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
            labels={labels}
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

/**
 * Palette used when a label is created from here. Workspace settings still owns
 * recolouring; picking by position keeps quick-created labels distinguishable
 * without asking for a colour mid-flow.
 */
const LABEL_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16'];

/** Multi-select label chips + dropdown with search and inline creation. */
function LabelsRailPicker({ value, labels, onChange, disabled }: {
  value: string[]; labels: LabelLite[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const selected = value.map((id) => labels.find((l) => l.id === id)).filter((l): l is LabelLite => !!l);
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

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };

  const needle = query.trim();
  const matches = needle
    ? labels.filter((l) => l.name.toLowerCase().includes(needle.toLowerCase()))
    : labels;
  const exists = labels.some((l) => l.name.toLowerCase() === needle.toLowerCase());
  const canCreate = can('settings.manage');

  return (
    <DropdownMenu trigger={trigger} align="start" width={240} className="w-full">
      <LabelsMenuBody
        labels={labels}
        matches={matches}
        value={value}
        query={query}
        onQuery={setQuery}
        onToggle={toggle}
        // The list is the source of truth for the current selection, so the new
        // label is added to the project in the same gesture that creates it.
        onCreated={(id) => { qc.invalidateQueries({ queryKey: ['labels'] }); onChange([...value, id]); setQuery(''); }}
        canCreate={canCreate && needle.length > 0 && !exists}
      />
    </DropdownMenu>
  );
}

function LabelsMenuBody({ labels, matches, value, query, onQuery, onToggle, onCreated, canCreate }: {
  labels: LabelLite[]; matches: LabelLite[]; value: string[]; query: string;
  onQuery: (v: string) => void; onToggle: (id: string) => void;
  onCreated: (id: string) => void; canCreate: boolean;
}) {
  const t = useT();
  const create = useMutation({
    mutationFn: (name: string) =>
      api.post<{ id: string }>('/labels', { name, color: LABEL_COLORS[labels.length % LABEL_COLORS.length] }),
    onSuccess: (r) => { onCreated(r.id); toast(t('projects.labelCreated')); },
    onError: () => toast.error(t('projects.labelCreateFailed')),
  });

  return (
    <div className="min-w-0">
      <div className="px-1 pb-1 pt-0.5">
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canCreate && !create.isPending) create.mutate(query.trim()); }}
          placeholder={t('projects.searchLabels')}
          autoFocus
          className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[13px] outline-none placeholder:text-faint focus:border-primary/60"
        />
      </div>
      <div className="max-h-52 overflow-y-auto">
        {/* Deliberately not MenuItem: picking labels is multi-select, so the
            menu has to survive each toggle. */}
        {matches.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onToggle(l.id)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: l.color ?? '#8a8f98' }} />
            <span className="min-w-0 flex-1 truncate">{l.name}</span>
            {value.includes(l.id) && <span className="shrink-0 text-primary">✓</span>}
          </button>
        ))}
        {matches.length === 0 && !canCreate && (
          <p className="px-2.5 py-2 text-xs text-faint">{labels.length === 0 ? t('projects.noLabelsYet') : t('projects.noLabelMatches')}</p>
        )}
      </div>
      {canCreate && (
        <>
          <div className="mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate(query.trim())}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted disabled:opacity-60"
          >
            {create.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Plus size={14} className="text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate">{t('projects.createLabel')} &ldquo;{query.trim()}&rdquo;</span>
          </button>
        </>
      )}
    </div>
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
