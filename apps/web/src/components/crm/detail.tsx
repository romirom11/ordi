/**
 * Shared building blocks for CRM detail pages (company + deal): inline-editable
 * title, owner picker, section shell, property rows and the notes section.
 * Notes attach to a company OR a deal – same editor, same rendering.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Check, Download, FileText, Paperclip, Pin, Trash2, Upload } from 'lucide-react';
import { api, qs, ApiError } from '../../lib/api';
import { openExternal } from '../../lib/desktop';
import { UploadError, uploadAttachment } from '../../lib/uploads';
import { useT } from '../../lib/i18n';
import { Avatar, Button, Card, EmptySection, IconButton, Skeleton, Spinner, Tooltip, cn, fmtDate } from '../ui';
import { ConfirmDialog, DropdownMenu, MenuItem, MenuLabel, toast } from '../overlays';
import { RichEditor } from '../richtext/RichEditor';
import { RichText, docIsEmpty } from '../richtext/RichText';

export interface Note { id: string; body?: unknown; createdAt?: string; authorName?: string; pinned?: boolean }
export interface FileRow { id: string; filename: string; size?: number | null; mime?: string | null; createdAt?: string }

/* ─────────────── Inline editable name ─────────────── */

export function EditableName({ value, editable, size = 'lg', onSave }: {
  value: string; editable: boolean;
  /** `sm` matches the one-line project/task header; `lg` is the CRM page title. */
  size?: 'sm' | 'lg';
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const type = size === 'sm' ? 'text-[15px] font-semibold' : 'text-xl font-semibold';

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
  if (!editable) return <h1 className={cn('min-w-0 truncate leading-tight', type)} title={value}>{value}</h1>;
  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className={cn('-mx-1.5 w-full max-w-md rounded-md border border-primary/40 bg-transparent px-1.5 leading-tight outline-none focus:ring-2 focus:ring-ring/25', type)}
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className={cn('-mx-1.5 block min-w-0 max-w-full truncate rounded-md px-1.5 text-left leading-tight transition-colors hover:bg-muted', type)}
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
      {/* Values wrap – an ellipsis in a 300px card hides exactly the data the card exists to show. */}
      <span className="min-w-0 break-words text-right">{children}</span>
    </div>
  );
}

/* ─────────────── Notes (company, lead or deal) ─────────────── */

export function NotesSection({ companyId, leadId, dealId, canWrite }: {
  companyId?: string;
  leadId?: string;
  dealId?: string;
  canWrite: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const target = companyId ? { companyId } : leadId ? { leadId } : { dealId };
  const queryKey = ['notes', companyId ?? leadId ?? dealId];
  const { data, isLoading } = useQuery<Note[]>({
    queryKey,
    queryFn: () => api.get<{ data: Note[] }>(`/notes${qs(target)}`).then((r) => r.data),
  });
  const [doc, setDoc] = useState<any>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDoc, setEditDoc] = useState<any>(null);
  const [toDelete, setToDelete] = useState<Note | null>(null);

  const create = useMutation({
    mutationFn: (body: any) => api.post('/notes', { ...target, body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); setDoc(null); setEditorKey((k) => k + 1); toast(t('common.saved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('crm.saveNoteFailed')),
  });

  const savingEditRef = useRef(false);
  const update = useMutation({
    mutationFn: (v: { id: string; body: any }) => api.patch(`/notes/${v.id}`, { body: v.body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); setEditingId(null); setEditDoc(null); toast(t('common.saved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('crm.saveNoteFailed')),
    onSettled: () => { savingEditRef.current = false; },
  });

  const pin = useMutation({
    mutationFn: (n: Note) => api.patch(`/notes/${n.id}`, { pinned: !n.pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/notes/${id}`),
    onSuccess: () => { setToDelete(null); qc.invalidateQueries({ queryKey }); toast(t('crm.noteDeleted')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const submit = () => { if (docIsEmpty(doc) || create.isPending) return; create.mutate(doc); };
  const notes = data ?? [];

  // Click-away saves the note being edited. Blur alone is not enough:
  // ProseMirror keeps focus when the click lands on non-focusable text.
  const editBoxRef = useRef<HTMLDivElement | null>(null);
  const editStateRef = useRef<{ id: string | null; doc: any }>({ id: null, doc: null });
  editStateRef.current = { id: editingId, doc: editDoc };

  // Click-away, blur and Cmd+Enter all commit the same edit, and a single click
  // on a focusable element fires two of them before the first PATCH resolves.
  // The ref guard keeps that one edit to one request (and one toast); the
  // mutation clears it in onSettled so a failed save can be retried.
  const commitEdit = useCallback(() => {
    if (savingEditRef.current) return;
    const { id, doc: cur } = editStateRef.current;
    if (!id) return;
    if (docIsEmpty(cur)) { setEditingId(null); setEditDoc(null); return; }
    savingEditRef.current = true;
    update.mutate({ id, body: cur });
  }, [update]);

  useEffect(() => {
    if (!editingId) return;
    const onDown = (e: MouseEvent) => {
      const box = editBoxRef.current;
      if (!box || box.contains(e.target as Node)) return;
      commitEdit();
    };
    document.addEventListener('mousedown', onDown, true);
    // The editor mounts unfocused – put the caret at the end so typing lands
    // in the note immediately, like clicking into a Notion block.
    requestAnimationFrame(() => {
      const el = editBoxRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!el) return;
      el.focus();
      const sel = window.getSelection();
      if (sel) { const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); sel.removeAllRanges(); sel.addRange(range); }
    });
    return () => document.removeEventListener('mousedown', onDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId]);

  return (
    <section>
      <SectionHeader icon={<Pin size={15} />} title={t('crm.notes')} count={notes.length} />
      {canWrite && (
        <div className="mb-4 rounded-lg border border-border/70 px-3 py-2 transition-colors focus-within:border-border-strong">
          <RichEditor key={editorKey} value={doc} onChange={setDoc} compact bare placeholder={t('crm.notePlaceholder')} onSubmit={submit} />
          {!docIsEmpty(doc) && (
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="ghost" size="xs" onClick={() => { setDoc(null); setEditorKey((k) => k + 1); }}>{t('common.cancel')}</Button>
              <Button size="xs" onClick={submit} disabled={create.isPending}>
                {create.isPending ? <Spinner /> : t('crm.saveNote')}
              </Button>
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : notes.length === 0 ? (
        // Only shown when there is no composer above it, so the section never
        // reads as empty twice.
        !canWrite && <EmptySection icon={<Pin size={14} />} title={t('crm.noNotes')} />
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <Card key={n.id} className={cn('group/note p-3', n.pinned && 'border-primary/30 bg-primary/[0.03]')}>
              {editingId === n.id ? (
                // Notion-style: the note body itself is the editor. Click-away and
                // focus-away save, Esc discards, Cmd/Ctrl+Enter saves explicitly.
                <div
                  ref={editBoxRef}
                  onBlur={(e) => {
                    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                    commitEdit();
                  }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditingId(null); setEditDoc(null); } }}
                >
                  <RichEditor value={editDoc} onChange={setEditDoc} compact bare onSubmit={commitEdit} />
                  {update.isPending && <div className="mt-1 flex justify-end"><Spinner /></div>}
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  {/* Click the text to edit in place – the same affordance as KB pages. */}
                  <div
                    className={cn('min-w-0 flex-1', canWrite && 'cursor-text')}
                    onClick={() => { if (canWrite) { setEditingId(n.id); setEditDoc(n.body); } }}
                  >
                    <RichText doc={n.body} className="text-[13px]" />
                  </div>
                  {canWrite && (
                    <span className="flex shrink-0 items-center">
                      <Tooltip label={t('common.delete')}>
                        <IconButton size="sm" aria-label={t('common.delete')} onClick={() => setToDelete(n)}
                          className="opacity-0 hover:text-destructive group-hover/note:opacity-100">
                          <Trash2 size={13} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip label={n.pinned ? t('crm.unpinNote') : t('crm.pinNote')}>
                        <IconButton
                          size="sm"
                          aria-label={n.pinned ? t('crm.unpinNote') : t('crm.pinNote')}
                          onClick={() => pin.mutate(n)}
                          className={cn(n.pinned ? 'text-primary opacity-100' : 'opacity-0 group-hover/note:opacity-100')}
                        >
                          <Pin size={13} className={cn(n.pinned && 'fill-current')} />
                        </IconButton>
                      </Tooltip>
                    </span>
                  )}
                </div>
              )}
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
                {n.pinned && <span className="font-medium text-primary">{t('crm.pinned')} ·</span>}
                {n.authorName ? `${n.authorName} · ` : ''}{fmtDate(n.createdAt)}
              </p>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('crm.deleteNoteTitle')}
        body={t('crm.deleteNoteBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </section>
  );
}

/* ─────────────── Files (company or deal) ─────────────── */

function fmtSize(bytes?: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Attachments for a CRM entity: presigned S3 upload (the app's standard file
 * path, PRD §14.5), list with download links, delete with confirm.
 */
export function FilesSection({ entityType, entityId, canWrite, variant = 'section' }: {
  entityType: 'company' | 'lead' | 'deal'; entityId: string; canWrite: boolean;
  /** `rail` renders the compact form used in the record's properties rail. */
  variant?: 'section' | 'rail';
}) {
  const t = useT();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [toDelete, setToDelete] = useState<FileRow | null>(null);

  const queryKey = ['attachments', entityType, entityId];
  const { data, isLoading } = useQuery<FileRow[]>({
    queryKey,
    queryFn: () => api.get<{ data: FileRow[] }>(`/attachments${qs({ entityType, entityId })}`).then((r) => r.data),
  });
  const files = data ?? [];

  const upload = async (file: File) => {
    setUploading(true);
    try {
      await uploadAttachment(file, { entityType, entityId });
      qc.invalidateQueries({ queryKey });
      toast(t('crm.fileUploaded'));
    } catch (e) {
      toast.error(e instanceof UploadError ? t(e.messageKey) : e instanceof ApiError ? e.message : t('crm.uploadFailed'));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const download = async (f: FileRow) => {
    const res = await api.get<{ url: string }>(`/attachments/${f.id}/url`);
    if (res.url.startsWith('local://')) { toast.error(t('crm.storageNotConfigured')); return; }
    openExternal(res.url);
  };

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/attachments/${id}`),
    onSuccess: () => { setToDelete(null); qc.invalidateQueries({ queryKey }); toast(t('crm.fileDeleted')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const picker = canWrite && (
    <input
      ref={inputRef}
      type="file"
      className="hidden"
      onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
    />
  );

  const confirmDelete = (
    <ConfirmDialog
      open={!!toDelete}
      onClose={() => setToDelete(null)}
      onConfirm={() => toDelete && del.mutate(toDelete.id)}
      title={t('crm.deleteFileTitle')}
      body={toDelete ? t('crm.deleteFileBody').replace('{name}', toDelete.filename) : ''}
      confirmLabel={t('common.delete')}
      danger
      pending={del.isPending}
    />
  );

  if (variant === 'rail') {
    return (
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('crm.files')}</h2>
          {picker}
          {canWrite && (
            <IconButton size="sm" aria-label={t('crm.uploadFile')} disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Spinner /> : <Upload size={13} />}
            </IconButton>
          )}
        </div>
        {isLoading ? (
          <Skeleton className="h-7" />
        ) : files.length === 0 ? (
          <p className="px-1.5 py-1 text-[13px] text-faint">{t('crm.noFiles')}</p>
        ) : (
          <div className="space-y-0.5">
            {files.map((f) => (
              <div key={f.id} className="group/file flex min-h-7 items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted">
                <FileText size={14} className="shrink-0 text-muted-foreground" />
                <button
                  onClick={() => download(f)}
                  className="min-w-0 flex-1 truncate text-left text-[13px]"
                  title={`${f.filename} · ${fmtSize(f.size)} · ${fmtDate(f.createdAt)}`}
                >
                  {f.filename}
                </button>
                {canWrite && (
                  <IconButton
                    size="sm"
                    aria-label={t('common.delete')}
                    onClick={() => setToDelete(f)}
                    className="shrink-0 opacity-0 transition-opacity duration-150 hover:text-destructive group-hover/file:opacity-100"
                  >
                    <Trash2 size={12} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
        )}
        {confirmDelete}
      </div>
    );
  }

  return (
    <section>
      <SectionHeader
        icon={<Paperclip size={15} />}
        title={t('crm.files')}
        count={files.length}
        action={canWrite && (
          <>
            {picker}
            <Button variant="outline" size="xs" disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Spinner /> : <Upload size={13} />} {t('crm.uploadFile')}
            </Button>
          </>
        )}
      />
      {isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-10 rounded-md" />)}</div>
      ) : files.length === 0 ? (
        <EmptySection icon={<Paperclip size={14} />} title={t('crm.noFiles')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {files.map((f, i) => (
            <div key={f.id} className={cn('group/file flex items-center gap-3 px-3 py-2', i > 0 && 'border-t border-border')}>
              <FileText size={16} className="shrink-0 text-muted-foreground" />
              <button onClick={() => download(f)} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:underline" title={f.filename}>
                {f.filename}
              </button>
              <span className="shrink-0 text-xs tabular-nums text-faint">{fmtSize(f.size)}</span>
              <span className="shrink-0 text-xs text-faint">{fmtDate(f.createdAt)}</span>
              <Tooltip label={t('crm.downloadFile')}>
                <IconButton size="sm" aria-label={t('crm.downloadFile')} onClick={() => download(f)}>
                  <Download size={13} />
                </IconButton>
              </Tooltip>
              {canWrite && (
                <Tooltip label={t('common.delete')}>
                  <IconButton size="sm" aria-label={t('common.delete')} onClick={() => setToDelete(f)}
                    className="opacity-0 transition-opacity duration-150 hover:text-destructive group-hover/file:opacity-100">
                    <Trash2 size={13} />
                  </IconButton>
                </Tooltip>
              )}
            </div>
          ))}
        </div>
      )}

      {confirmDelete}
    </section>
  );
}
