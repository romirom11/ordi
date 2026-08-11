/**
 * Lead labels: the chips and the rail picker. Same vocabulary mechanics as
 * tasks and projects (scoped `labels`, LabelsMenu body), CRM look for the
 * trigger so it sits in the lead rail like every other property.
 */
import { Tag } from 'lucide-react';
import { useLabels, type LabelLookup } from '../../lib/queries';
import { cn } from '../ui';
import { DropdownMenu } from '../overlays';
import { LabelsMenu } from '../LabelsMenu';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'crm.labels': 'Labels',
    'crm.addLabels': 'Add labels',
  },
  uk: {
    'crm.labels': 'Мітки',
    'crm.addLabels': 'Додати мітки',
  },
});

export function LeadLabelChip({ label }: { label: LabelLookup }) {
  return (
    <span className="inline-flex h-[18px] max-w-full items-center gap-1 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: label.color ?? '#8a8f98' }} />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

/** Read-only chips for list rows; resolves ids against the lead vocabulary. */
export function LeadLabelChips({ labelIds, max = 3 }: { labelIds?: string[]; max?: number }) {
  const labels = useLabels('lead').data ?? [];
  const selected = (labelIds ?? [])
    .map((id) => labels.find((label) => label.id === id))
    .filter((label): label is LabelLookup => !!label);
  if (selected.length === 0) return null;
  const shown = selected.slice(0, max);
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {shown.map((label) => <LeadLabelChip key={label.id} label={label} />)}
      {selected.length > shown.length && (
        <span className="text-[11px] text-faint">+{selected.length - shown.length}</span>
      )}
    </span>
  );
}

/** Chips + picker for the lead detail rail, mirroring the project rail's. */
export function LeadLabelsRailPicker({ value, onChange, disabled }: {
  value: string[]; onChange: (ids: string[]) => void; disabled?: boolean;
}) {
  const t = useT();
  const labels = useLabels('lead').data ?? [];
  const selected = value
    .map((id) => labels.find((label) => label.id === id))
    .filter((label): label is LabelLookup => !!label);
  const trigger = (
    <span className={cn(
      'group flex min-h-7 w-full flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-[13px] transition-colors duration-150',
      disabled ? 'cursor-default' : 'cursor-pointer hover:bg-muted',
      selected.length === 0 && 'text-faint',
    )}>
      {selected.length === 0 ? (
        <><Tag size={14} className="text-faint" /><span className="truncate">{disabled ? '–' : t('crm.addLabels')}</span></>
      ) : selected.map((label) => <LeadLabelChip key={label.id} label={label} />)}
    </span>
  );
  if (disabled) return trigger;
  return (
    <DropdownMenu trigger={trigger} align="start" width={240} className="w-full">
      <LabelsMenu scope="lead" value={value} onChange={onChange} />
    </DropdownMenu>
  );
}
