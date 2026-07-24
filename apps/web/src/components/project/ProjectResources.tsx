/**
 * Resources row on the project overview: link chips (open in a new tab) plus
 * an add dialog; edit/remove live in a right-click context menu on each chip.
 */
import { useState, type FormEvent } from 'react';
import { Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button, Input, Spinner, cn } from '../ui';
import { ContextMenu, Dialog } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'projects.resources': 'Resources',
    'projects.addResource': 'Add resource',
    'projects.editResource': 'Edit resource',
    'projects.resourceLabel': 'Label',
    'projects.resourceUrl': 'URL',
    'projects.resourceLabelPh': 'e.g. Figma designs',
    'projects.resourceUrlInvalid': 'Enter a valid URL starting with http(s)://',
    'projects.removeResource': 'Remove',
    'projects.editResourceAction': 'Edit',
  },
  uk: {
    'projects.resources': 'Ресурси',
    'projects.addResource': 'Додати ресурс',
    'projects.editResource': 'Редагувати ресурс',
    'projects.resourceLabel': 'Назва',
    'projects.resourceUrl': 'URL',
    'projects.resourceLabelPh': 'напр., Макети у Figma',
    'projects.resourceUrlInvalid': 'Введіть коректний URL, що починається з http(s)://',
    'projects.removeResource': 'Прибрати',
    'projects.editResourceAction': 'Редагувати',
  },
});

export interface ProjectLink { label: string; url: string }

function isValidUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function ProjectResources({ links, canWrite, pending, onChange }: {
  links: ProjectLink[];
  canWrite: boolean;
  pending?: boolean;
  onChange: (next: ProjectLink[]) => void;
}) {
  const t = useT();
  // Dialog state: null = closed, -1 = adding, >=0 = editing that index.
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (!canWrite && links.length === 0) return null;

  const openAdd = () => { setLabel(''); setUrl(''); setError(null); setEditIndex(-1); };
  const openEdit = (i: number) => {
    const l = links[i];
    if (!l) return;
    setLabel(l.label); setUrl(l.url); setError(null); setEditIndex(i);
  };
  const close = () => setEditIndex(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const lab = label.trim();
    const u = url.trim();
    if (!lab) { setError(t('common.nameRequired')); return; }
    if (!isValidUrl(u)) { setError(t('projects.resourceUrlInvalid')); return; }
    const next = links.slice();
    if (editIndex != null && editIndex >= 0) next[editIndex] = { label: lab, url: u };
    else next.push({ label: lab, url: u });
    onChange(next);
    close();
  };

  const remove = (i: number) => onChange(links.filter((_, idx) => idx !== i));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {links.map((l, i) => {
          const chip = (
            <a
              href={l.url}
              target="_blank"
              rel="noreferrer noopener"
              title={l.url}
              className={cn(
                'inline-flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-border bg-card px-2.5',
                'text-[13px] transition-colors duration-150 hover:border-border-strong hover:bg-muted',
              )}
            >
              <Link2 size={13} className="shrink-0 text-faint" />
              <span className="truncate font-medium">{l.label}</span>
              {hostOf(l.url) && <span className="hidden truncate text-[11px] text-faint sm:block">{hostOf(l.url)}</span>}
            </a>
          );
          return canWrite ? (
            <ContextMenu
              key={`${l.url}-${i}`}
              items={[
                { key: 'edit', label: t('projects.editResourceAction'), icon: <Pencil size={14} />, onSelect: () => openEdit(i) },
                { type: 'separator' },
                { key: 'remove', label: t('projects.removeResource'), icon: <Trash2 size={14} />, danger: true, onSelect: () => remove(i) },
              ]}
            >
              {chip}
            </ContextMenu>
          ) : <span key={`${l.url}-${i}`}>{chip}</span>;
        })}
        {canWrite && (
          <button
            type="button"
            onClick={openAdd}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-border px-2.5 text-[13px]',
              'text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground',
            )}
          >
            <Plus size={13} />
            {links.length === 0 ? t('projects.addResource') : null}
          </button>
        )}
      </div>

      <Dialog
        open={editIndex != null}
        onClose={close}
        title={editIndex != null && editIndex >= 0 ? t('projects.editResource') : t('projects.addResource')}
        width={420}
      >
        <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('projects.resourceLabel')}</label>
            <Input autoFocus value={label} placeholder={t('projects.resourceLabelPh')} onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">{t('projects.resourceUrl')}</label>
            <Input value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={close}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={pending}>{pending ? <Spinner /> : t('common.save')}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
