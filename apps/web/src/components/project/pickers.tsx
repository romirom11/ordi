import { type ReactNode } from 'react';
import {
  Building2, CalendarDays, Circle, Globe, Lock, UserCircle2, X,
} from 'lucide-react';
import { Avatar, RailChip, RailField, fmtDate } from '../ui';
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator, useMenuClose } from '../overlays';
import { SearchSelect } from '../SearchSelect';
import { Calendar } from '../DatePicker';
import { useT, extendDict } from '../../lib/i18n';
import { activeUsers, byName } from '../../lib/queries';

export interface UserLite { id: string; name: string; avatar?: string | null; isActive?: boolean }
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

/* Rail primitives live in ui.tsx – re-exported so the project pickers stay the
 * one import site for everything the properties rail needs. */
export { RailField };

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
      {activeUsers(users).map((u) => (
        <MenuItem key={u.id} icon={<Avatar name={u.name} src={u.avatar} size={18} />} onSelect={() => onSelect(u.id)} checked={value === u.id}>
          {u.name}
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}

/* ───────────────────────────── Dates ───────────────────────────── */

/** The shared calendar inside a menu: picking a day applies it and closes. */
function CalendarInMenu({ value, onSelect }: { value?: string | null; onSelect: (day: string) => void }) {
  const close = useMenuClose();
  return <Calendar value={value} onSelect={(day) => { onSelect(day); close(); }} />;
}

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
    <DropdownMenu trigger={trigger} align="start" width={264} className="w-full">
      <CalendarInMenu value={value} onSelect={(day) => onChange(day)} />
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
    <SearchSelect
      align="start"
      width={230}
      className="w-full"
      value={value ?? ''}
      onChange={(id) => onSelect(id || null)}
      menuLabel={t('projects.company')}
      trigger={trigger}
      options={[
        { value: '', label: t('projects.noCompany'), icon: <Circle size={14} /> },
        ...byName(companies).map((c) => ({ value: c.id, label: c.name, icon: <Building2 size={15} /> })),
      ]}
    />
  );
}
