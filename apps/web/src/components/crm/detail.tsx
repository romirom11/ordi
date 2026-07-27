/**
 * Shared building blocks for CRM detail pages (company + deal): inline-editable
 * title, owner picker, section shell, property rows and the notes section.
 * Notes attach to a company OR a deal – same editor, same rendering.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check, Pin } from 'lucide-react';
import { api, qs, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Avatar, Button, Card, EmptyState, IconButton, Skeleton, Spinner, Tooltip, cn, fmtDate } from '../ui';
import { DropdownMenu, MenuItem, MenuLabel, toast } from '../overlays';
import { RichEditor } from '../richtext/RichEditor';
import { RichText, docIsEmpty } from '../richtext/RichText';

export interface Note { id: string; body?: unknown; createdAt?: string; authorName?: string; pinned?: boolean }

/* ─────────────── Inline editable name ─────────────── */

export function EditableName({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    else setDraft(value);
  };

  // Titles can be long (an agent-written deal title is a whole sentence) – clamp
  // to one line with the full text on hover, the way KB and task headers do.
  if (!editable) return <h1 className="truncate text-xl font-semibold leading-tight" title={value}>{value}</h1>;
  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className="-mx-1.5 w-full max-w-md rounded-md border border-primary/40 bg-transparent px-1.5 text-xl font-semibold leading-tight outline-none focus:ring-2 focus:ring-ring/25"
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className="-mx-1.5 block max-w-full truncate rounded-md px-1.5 text-left text-xl font-semibold leading-tight transition-colors hover:bg-muted"
      title={value}
    >
      {value}
    </button>
  );
}

/* ─────────────── Owner picker ─────────────── */

export function OwnerPicker({ owner, users, editable, onPick }: {
  owner?: { id: string; name: string; avatar?: string | null };
  users: { id: string; name: string; avatar?: string | null }[];
  editable: boolean;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const content = (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {owner ? <Avatar name={owner.name} src={owner.avatar} size={18} /> : <span className="grid h-[18px] w-[18px] place-items-center rounded-full border border-dashed border-border-strong text-[10px] text-faint">?</span>}
      {owner ? owner.name : t('crm.noOwner')}
    </span>
  );
  if (!editable) return content;
  return (
    <DropdownMenu
      align="start"
      trigger={<button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted">{content}<ChevronDown size={12} className="text-faint" /></button>}
    >
      <MenuLabel>{t('crm.changeOwner')}</MenuLabel>
      {users.map((u) => (
        <MenuItem key={u.id} onSelect={() => u.id !== owner?.id && onPick(u.id)}>
          <span className="flex items-center gap-2">
            <Avatar name={u.name} src={u.avatar} size={18} />
            <span className="flex-1">{u.name}</span>
            {owner?.id === u.id && <Check size={13} className="text-primary" />}
          </span>
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}

/* ─────────────── Section shell ─────────────── */

export function SectionHeader({ icon, title, count, action }: { icon: React.ReactNode; title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
        {count !== undefined && count > 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>}
      </h2>
      {action}
    </div>
  );
}

/* ─────────────── Property row ─────────────── */

export function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

/* ─────────────── Notes (company or deal) ─────────────── */

export function NotesSection({ companyId, dealId, canWrite }: { companyId?: string; dealId?: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const target = companyId ? { companyId } : { dealId };
  const queryKey = ['notes', companyId ?? dealId];
  const { data, isLoading } = useQuery<Note[]>({
    queryKey,
    queryFn: () => api.get<{ data: Note[] }>(`/notes${qs(target)}`).then((r) => r.data),
  });
  const [doc, setDoc] = useState<any>(null);
  const [editorKey, setEditorKey] = useState(0);

  const create = useMutation({
    mutationFn: (body: any) => api.post('/notes', { ...target, body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); setDoc(null); setEditorKey((k) => k + 1); toast(t('common.saved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('crm.saveNoteFailed')),
  });

  const pin = useMutation({
    mutationFn: (n: Note) => api.patch(`/notes/${n.id}`, { pinned: !n.pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const submit = () => { if (docIsEmpty(doc) || create.isPending) return; create.mutate(doc); };
  const notes = data ?? [];

  return (
    <section>
      <SectionHeader icon={<Pin size={15} />} title={t('crm.notes')} count={notes.length} />
      {canWrite && (
        <div className="mb-4 space-y-2">
          <RichEditor key={editorKey} value={doc} onChange={setDoc} compact placeholder={t('crm.notePlaceholder')} onSubmit={submit} />
          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={create.isPending || docIsEmpty(doc)}>
              {create.isPending ? <Spinner /> : t('crm.saveNote')}
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : notes.length === 0 ? (
        <EmptyState icon={<Pin size={18} />} title={t('crm.noNotes')} hint={t('crm.noNotesHint')} />
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <Card key={n.id} className={cn('group/note p-3', n.pinned && 'border-primary/30 bg-primary/[0.03]')}>
              <div className="flex items-start justify-between gap-2">
                <RichText doc={n.body} className="min-w-0 flex-1 text-[13px]" />
                {canWrite && (
                  <Tooltip label={n.pinned ? t('crm.unpinNote') : t('crm.pinNote')}>
                    <IconButton
                      size="sm"
                      onClick={() => pin.mutate(n)}
                      className={cn(n.pinned ? 'text-primary opacity-100' : 'opacity-0 group-hover/note:opacity-100')}
                    >
                      <Pin size={13} className={cn(n.pinned && 'fill-current')} />
                    </IconButton>
                  </Tooltip>
                )}
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
                {n.pinned && <span className="font-medium text-primary">{t('crm.pinned')} ·</span>}
                {n.authorName ? `${n.authorName} · ` : ''}{fmtDate(n.createdAt)}
              </p>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
