import { type ReactNode } from 'react';
import { CalendarDays, ChevronDown, UserCircle2 } from 'lucide-react';
import { Avatar, cn, fmtDate } from '../ui';
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from '../overlays';
import { useT } from '../../lib/i18n';

export interface UserLite { id: string; name: string; avatar?: string | null }

/** Inline pill trigger used across the project header property row. */
function PropTrigger({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] transition-colors duration-150',
        disabled ? 'cursor-default text-muted-foreground' : 'cursor-pointer text-foreground hover:bg-muted',
      )}
    >
      {children}
    </span>
  );
}

export function LeadPicker({ value, users, onSelect, disabled }: {
  value?: string | null; users: UserLite[]; onSelect: (id: string | null) => void; disabled?: boolean;
}) {
  const t = useT();
  const lead = value ? users.find((u) => u.id === value) : undefined;
  const trigger = (
    <PropTrigger disabled={disabled}>
      {lead
        ? <><Avatar name={lead.name} src={lead.avatar} size={18} /><span className="max-w-32 truncate">{lead.name}</span></>
        : <><UserCircle2 size={16} className="text-faint" /><span className="text-muted-foreground">{t('projects.noLead')}</span></>}
      {!disabled && <ChevronDown size={13} className="text-faint" />}
    </PropTrigger>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={220}>
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

export function DatePickerMenu({ value, onChange, placeholder, icon, disabled }: {
  value?: string | null; onChange: (v: string | null) => void; placeholder: string; icon?: ReactNode; disabled?: boolean;
}) {
  const t = useT();
  const trigger = (
    <PropTrigger disabled={disabled}>
      {icon ?? <CalendarDays size={15} className="text-faint" />}
      {value ? <span className="tabular-nums">{fmtDate(value)}</span> : <span className="text-muted-foreground">{placeholder}</span>}
    </PropTrigger>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={200}>
      <div className="p-1">
        <input
          type="date"
          defaultValue={value ? value.slice(0, 10) : ''}
          onChange={(e) => onChange(e.target.value || null)}
          className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] outline-none focus:border-primary/60"
        />
      </div>
      {value && (<><MenuSeparator /><MenuItem danger onSelect={() => onChange(null)}>{t('projects.clearDate')}</MenuItem></>)}
    </DropdownMenu>
  );
}
