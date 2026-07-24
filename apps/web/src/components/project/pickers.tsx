import { type ReactNode } from 'react';
import {
  Building2, CalendarDays, ChevronDown, Circle, Globe, Lock, UserCircle2, X,
} from 'lucide-react';
import { Avatar, cn, fmtDate } from '../ui';
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

export interface UserLite { id: string; name: string; avatar?: string | null }
export interface CompanyLite { id: string; name: string }

extendDict({
  en: {
    'projects.noCompany': 'No client',
    'projects.company': 'Client',
    'projects.selectCompany': 'Select client…',
  },
  uk: {
    'projects.noCompany': 'Без клієнта',
    'projects.company': 'Клієнт',
    'projects.selectCompany': 'Обрати клієнта…',
  },
});

/** Project status metadata – single source used by the header, rail and settings. */
export const PROJECT_STATUSES = ['active', 'paused', 'completed', 'archived'] as const;
export type ProjectStatus = typeof PROJECT_STATUSES[number];
export const STATUS_META: Record<string, { color: string; key: string }> = {
  active: { color: '#22c55e', key: 'projects.statusActive' },
  paused: { color: '#eab308', key: 'projects.statusPaused' },
  completed: { color: '#5e6ad2', key: 'projects.statusCompleted' },
  archived: { color: '#8a8f98', key: 'projects.statusArchived' },
};

/* ───────────── Rail primitives (Linear-style property rows) ───────────── */

/** Labeled row: faint label on the left, control filling the rest. */
export function RailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="w-[76px] shrink-0 pt-[7px] text-xs text-faint">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Full-width trigger chip that hovers, matching the task sidebar. */
function RailChip({ children, empty, disabled, caret }: {
  children: ReactNode; empty?: boolean; disabled?: boolean; caret?: boolean;
}) {
  return (
    <span
      className={cn(
        'group flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px]',
        'transition-colors duration-150',
        disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted',
        empty && 'text-faint',
      )}
    >
      {children}
      {caret && !disabled && (
        <ChevronDown size={13} className="ml-auto shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </span>
  );
}

/* ───────────────────────────── Lead ───────────────────────────── */

export function LeadPicker({ value, users, onSelect, disabled }: {
  value?: string | null; users: UserLite[]; onSelect: (id: string | null) => void; disabled?: boolean;
}) {
  const t = useT();
  const lead = value ? users.find((u) => u.id === value) : undefined;
  const trigger = (
    <RailChip empty={!lead} disabled={disabled} caret>
      {lead
        ? <><Avatar name={lead.name} src={lead.avatar} size={18} /><span className="truncate">{lead.name}</span></>
        : <><UserCircle2 size={16} className="text-faint" /><span className="truncate">{t('projects.noLead')}</span></>}
    </RailChip>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={220} className="w-full">
      <MenuLabel>{t('projects.lead')}</MenuLabel>
      <MenuItem icon={<UserCircle2 size={16} />} onSelect={() => onSelect(null)} checked={!value}>{t('projects.noLead')}</MenuItem>
      <MenuSeparator />
      {users.map((u) => (
        <MenuItem key={u.id} icon={<Avatar name={u.name} src={u.avatar} size={18} />} onSelect={() => onSelect(u.id)} checked={value === u.id}>
          {u.name}
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}

/* ───────────────────────────── Dates ───────────────────────────── */

export function DateRailPicker({ value, onChange, placeholder, icon, disabled }: {
  value?: string | null; onChange: (v: string | null) => void; placeholder: string; icon?: ReactNode; disabled?: boolean;
}) {
  const t = useT();
  const trigger = (
    <RailChip empty={!value} disabled={disabled} caret>
      {icon ?? <CalendarDays size={15} className="text-faint" />}
      {value ? <span className="truncate tabular-nums">{fmtDate(value)}</span> : <span className="truncate">{placeholder}</span>}
    </RailChip>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={210} className="w-full">
      <div className="p-1.5">
        <input
          type="date"
          defaultValue={value ? value.slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value || null)}
          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] outline-none transition-colors duration-150 hover:border-border-strong focus:border-primary/60"
        />
      </div>
      {value && (<><MenuSeparator /><MenuItem icon={<X size={14} />} danger onSelect={() => onChange(null)}>{t('projects.clearDate')}</MenuItem></>)}
    </DropdownMenu>
  );
}

/* ───────────────────────────── Status ───────────────────────────── */

export function ProjectStatusPicker({ value, onSelect, disabled }: {
  value: string; onSelect: (s: ProjectStatus) => void; disabled?: boolean;
}) {
  const t = useT();
  const meta = STATUS_META[value] ?? { color: '#8a8f98', key: '' };
  const trigger = (
    <RailChip disabled={disabled} caret>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
      <span className="truncate">{meta.key ? t(meta.key) : value}</span>
    </RailChip>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={190} className="w-full">
      <MenuLabel>{t('common.status')}</MenuLabel>
      {PROJECT_STATUSES.map((s) => (
        <MenuItem key={s} checked={value === s} onSelect={() => { if (s !== value) onSelect(s); }}
          icon={<span className="h-2 w-2 rounded-full" style={{ backgroundColor: STATUS_META[s]!.color }} />}>
          {t(STATUS_META[s]!.key)}
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}

/* ───────────────────────────── Visibility ───────────────────────────── */

export function VisibilityPicker({ value, onSelect, disabled }: {
  value?: string; onSelect: (v: 'workspace' | 'private') => void; disabled?: boolean;
}) {
  const t = useT();
  const isPrivate = value === 'private';
  const trigger = (
    <RailChip disabled={disabled} caret>
      {isPrivate ? <Lock size={14} className="text-faint" /> : <Globe size={14} className="text-faint" />}
      <span className="truncate">{isPrivate ? t('projects.visPrivate') : t('projects.visWorkspace')}</span>
    </RailChip>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={260} className="w-full">
      <MenuLabel>{t('projects.visibility')}</MenuLabel>
      <MenuItem icon={<Globe size={15} />} checked={!isPrivate} onSelect={() => { if (isPrivate) onSelect('workspace'); }}>
        <span className="flex flex-col">
          <span>{t('projects.visWorkspace')}</span>
          <span className="text-xs text-faint">{t('projects.visWorkspaceHint')}</span>
        </span>
      </MenuItem>
      <MenuItem icon={<Lock size={15} />} checked={isPrivate} onSelect={() => { if (!isPrivate) onSelect('private'); }}>
        <span className="flex flex-col">
          <span>{t('projects.visPrivate')}</span>
          <span className="text-xs text-faint">{t('projects.visPrivateHint')}</span>
        </span>
      </MenuItem>
    </DropdownMenu>
  );
}

/* ───────────────────────────── Company / Client ───────────────────────────── */

export function CompanyPicker({ value, companyName, companies, onSelect, disabled }: {
  value?: string | null; companyName?: string | null; companies: CompanyLite[];
  onSelect: (id: string | null) => void; disabled?: boolean;
}) {
  const t = useT();
  const current = value ? (companies.find((c) => c.id === value)?.name ?? companyName) : null;
  const trigger = (
    <RailChip empty={!current} disabled={disabled} caret>
      {current
        ? <><Building2 size={15} className="text-faint" /><span className="truncate">{current}</span></>
        : <><Circle size={14} className="text-faint" /><span className="truncate">{t('projects.noCompany')}</span></>}
    </RailChip>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={230} className="w-full">
      <MenuLabel>{t('projects.company')}</MenuLabel>
      <MenuItem icon={<Circle size={14} />} onSelect={() => onSelect(null)} checked={!value}>{t('projects.noCompany')}</MenuItem>
      <MenuSeparator />
      {companies.map((c) => (
        <MenuItem key={c.id} icon={<Building2 size={15} />} onSelect={() => onSelect(c.id)} checked={value === c.id}>
          {c.name}
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}
