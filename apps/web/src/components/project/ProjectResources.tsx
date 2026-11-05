/**
 * Resources on the project overview: links, files and knowledge-base pages in
 * one ordered list (GET /projects/:id/resources). "Add" offers each kind; rows
 * drag to reorder, and files dropped from the desktop upload into the list.
 *
 * - a link opens in a new tab and edits in a dialog (label + url),
 * - a file previews on click, downloads, renames in place (the attachment's
 *   name) and is deleted when removed,
 * - a page opens in the knowledge base; removing it only unpins it,
 * - a secret opens its panel (SecretPanel); values never reach this list.
 */
import { useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, BookOpen, Bot, Cloud, Download, FileText, FolderOpen, GripVertical, KeyRound, Link2, Pencil, Plus, Search, Trash2, Upload,
} from 'lucide-react';
import { api, qs, ApiError } from '../../lib/api';
import { openExternal } from '../../lib/desktop';
import { useOpen, useSearchParams } from '../../lib/router';
import { useCan } from '../../lib/auth';
import { UploadError, resolveFileSrc, uploadAttachment } from '../../lib/uploads';
import { Button, IconButton, Input, Skeleton, Spinner, Tooltip, cn } from '../ui';
import { ConfirmDialog, Dialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { FilePreviewDialog } from '../FilePreview';
import { RenameInput, fmtSize, type FileRow } from '../FilesSection';
import { useT, extendDict } from '../../lib/i18n';
import type { UserLite } from './pickers';
import { SecretDialog } from './SecretDialog';
import { ExpiryHint, SecretPanel } from './SecretPanel';
import { ENV_TONE, PROVIDER_NAME, type ProviderConnection, type SecretView } from './secretsShared';

extendDict({
  en: {
    'projects.resources': 'Resources',
    'projects.addResource': 'Add',
    'projects.addLink': 'Link',
    'projects.addFile': 'Upload file',
    'projects.addPage': 'Knowledge base page',
    'projects.editResource': 'Edit link',
    'projects.newLink': 'Add link',
    'projects.resourceLabel': 'Label',
    'projects.resourceUrl': 'URL',
    'projects.resourceLabelPh': 'e.g. Figma designs',
    'projects.resourceUrlInvalid': 'Enter a valid URL starting with http(s)://',
    'projects.removeResource': 'Remove',
    'projects.unpinPage': 'Unpin',
    'projects.editResourceAction': 'Edit',
    'projects.resourcesEmpty': 'Links, files, knowledge base pages and secrets the team needs for this project.',
    'projects.resourcesDrop': 'Drop files to upload',
    'projects.resourceMoved': 'Order saved',
    'projects.pickPage': 'Pin a knowledge base page',
    'projects.pickPagePh': 'Search pages…',
    'projects.pickPageEmpty': 'No pages match.',
    'projects.pickPageHint': 'Type to search the knowledge base.',
    'projects.pagePinned': 'Page pinned',
    'projects.resourceKb': 'Knowledge base',
    'projects.dragToReorder': 'Drag to reorder',
  },
  uk: {
    'projects.resources': 'Ресурси',
    'projects.addResource': 'Додати',
    'projects.addLink': 'Посилання',
    'projects.addFile': 'Завантажити файл',
    'projects.addPage': 'Сторінка бази знань',
    'projects.editResource': 'Редагувати посилання',
    'projects.newLink': 'Додати посилання',
    'projects.resourceLabel': 'Назва',
    'projects.resourceUrl': 'URL',
    'projects.resourceLabelPh': 'напр., Макети у Figma',
    'projects.resourceUrlInvalid': 'Введіть коректний URL, що починається з http(s)://',
    'projects.removeResource': 'Прибрати',
    'projects.unpinPage': 'Відкріпити',
    'projects.editResourceAction': 'Редагувати',
    'projects.resourcesEmpty': 'Посилання, файли, сторінки бази знань і секрети, потрібні команді для цього проєкту.',
    'projects.resourcesDrop': 'Відпустіть файли, щоб завантажити',
    'projects.resourceMoved': 'Порядок збережено',
    'projects.pickPage': 'Закріпити сторінку бази знань',
    'projects.pickPagePh': 'Пошук сторінок…',
    'projects.pickPageEmpty': 'Сторінок не знайдено.',
    'projects.pickPageHint': 'Почніть вводити, щоб шукати в базі знань.',
    'projects.pagePinned': 'Сторінку закріплено',
    'projects.resourceKb': 'База знань',
    'projects.dragToReorder': 'Перетягніть, щоб змінити порядок',
  },
});

export interface ProjectResource {
  id: string;
  kind: 'link' | 'file' | 'kb_page' | 'secret';
  label: string;
  url: string | null;
  position: number;
  file?: { id: string; filename: string; size: number; mime: string };
  page?: { id: string; title: string; icon: string | null; spaceId: string; url: string };
  secret?: SecretView;
}

function isValidUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function hostOf(url: string | null): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const KIND_ICON = { link: Link2, file: FileText, kb_page: BookOpen, secret: KeyRound } as const;

export function ProjectResources({ projectId, canWrite, users = [] }: { projectId: string; canWrite: boolean; users?: UserLite[] }) {
  const t = useT();
  const qc = useQueryClient();
  const open = useOpen();
  const queryKey = useMemo(() => ['project-resources', projectId], [projectId]);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery<ProjectResource[]>({
    queryKey,
    queryFn: () => api.get<{ data: ProjectResource[] }>(`/projects/${projectId}/resources`).then((r) => r.data),
  });
  const resources = data ?? [];

  const [linkDialog, setLinkDialog] = useState<ProjectResource | 'new' | null>(null);
  const [pagePicker, setPagePicker] = useState(false);
  const can = useCan();
  const params = useSearchParams();
  // A notification links here with ?secret=<id> to open that secret.
  const [openSecret, setOpenSecret] = useState<string | null>(params.get('secret'));
  const [secretDialog, setSecretDialog] = useState<SecretView | 'new' | { provider: ProviderConnection } | null>(null);
  // Connections to Doppler and the like that this project may add secrets from.
  const providersQ = useQuery<ProviderConnection[]>({
    queryKey: ['project-secret-providers', projectId],
    queryFn: () => api.get<{ data: ProviderConnection[] }>(`/projects/${projectId}/secret-providers`).then((r) => r.data),
    enabled: can('secrets.write') && canWrite,
    staleTime: 60_000,
    retry: false,
  });
  const providers = providersQ.data ?? [];
  const dialogSecret = secretDialog && secretDialog !== 'new' && 'id' in secretDialog ? secretDialog : null;
  const dialogProvider = secretDialog && secretDialog !== 'new' && !('id' in secretDialog) ? secretDialog.provider : null;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [preview, setPreview] = useState<FileRow | null>(null);
  const [toDelete, setToDelete] = useState<ProjectResource | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [fileOver, setFileOver] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: ['project-audit', projectId] });
  };
  const onErr = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/project-resources/${id}`),
    onSuccess: () => { setToDelete(null); invalidate(); },
    onError: onErr,
  });

  const renameFile = useMutation({
    mutationFn: (vars: { attachmentId: string; filename: string }) =>
      api.patch(`/attachments/${vars.attachmentId}`, { filename: vars.filename }),
    onMutate: (vars) => {
      setRenaming(null);
      qc.setQueryData<ProjectResource[]>(queryKey, (old) => (old ?? []).map((r) => (
        r.file?.id === vars.attachmentId ? { ...r, label: vars.filename, file: { ...r.file, filename: vars.filename } } : r
      )));
    },
    onSuccess: () => toast(t('crm.fileRenamed')),
    onError: onErr,
    onSettled: invalidate,
  });

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.put(`/projects/${projectId}/resources/order`, { ids }),
    onMutate: (ids) => {
      const prev = qc.getQueryData<ProjectResource[]>(queryKey);
      const byId = new Map((prev ?? []).map((r) => [r.id, r]));
      qc.setQueryData<ProjectResource[]>(queryKey, ids.map((id) => byId.get(id)).filter((r): r is ProjectResource => !!r));
      return { prev };
    },
    onError: (e, _ids, ctx) => { if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev); onErr(e); },
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });

  /** Sequential on purpose: one clear error per file beats a burst of retries. */
  const upload = async (picked: File[]) => {
    if (!picked.length) return;
    setUploading(true);
    let ok = 0;
    let firstError: string | null = null;
    for (const file of picked) {
      try {
        await uploadAttachment(file, { entityType: 'project', entityId: projectId });
        ok += 1;
      } catch (e) {
        const message = e instanceof UploadError ? t(e.messageKey) : e instanceof ApiError ? e.message : t('crm.uploadFailed');
        if (!firstError) firstError = picked.length > 1 ? `${file.name}: ${message}` : message;
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
    if (ok) invalidate();
    if (firstError) toast.error(firstError);
    else toast(ok === 1 ? t('crm.fileUploaded') : t('crm.filesUploaded').replace('{n}', String(ok)));
  };

  const download = async (attachmentId: string) => {
    const res = await api.get<{ url: string }>(`/attachments/${attachmentId}/url`);
    openExternal(resolveFileSrc(res.url));
  };

  const activate = (r: ProjectResource, e?: React.MouseEvent) => {
    // The API takes http(s) only; checked again so nothing else is ever opened.
    if (r.kind === 'link' && r.url && isValidUrl(r.url)) openExternal(r.url);
    else if (r.kind === 'file' && r.file) setPreview({ id: r.file.id, filename: r.file.filename, size: r.file.size, mime: r.file.mime });
    else if (r.kind === 'kb_page' && r.page) open(r.page.url, e);
    else if (r.kind === 'secret' && r.secret) setOpenSecret(r.secret.id);
  };

  // ── Drag and drop: rows reorder; files from the desktop upload ──
  const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropOn = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = resources.map((r) => r.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    reorder.mutate(ids);
  };
  const sectionDrop = canWrite ? {
    onDragOver: (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (!fileOver) setFileOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFileOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      setFileOver(false);
      upload(Array.from(e.dataTransfer.files));
    },
  } : {};

  if (!canWrite && !isLoading && resources.length === 0) return null;

  const addMenu = canWrite && (
    <>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => { if (e.target.files?.length) upload(Array.from(e.target.files)); }}
      />
      <DropdownMenu
        align="end"
        width={220}
        trigger={
          <Button variant="outline" size="xs" disabled={uploading}>
            {uploading ? <Spinner /> : <Plus size={13} />} {t('projects.addResource')}
          </Button>
        }
      >
        <MenuItem icon={<Link2 size={14} />} onSelect={() => setLinkDialog('new')}>{t('projects.addLink')}</MenuItem>
        <MenuItem icon={<Upload size={14} />} onSelect={() => fileInput.current?.click()}>{t('projects.addFile')}</MenuItem>
        <MenuItem icon={<BookOpen size={14} />} onSelect={() => setPagePicker(true)}>{t('projects.addPage')}</MenuItem>
        {can('secrets.write') && (
          <MenuItem icon={<KeyRound size={14} />} onSelect={() => setSecretDialog('new')}>{t('secrets.secret')}</MenuItem>
        )}
        {can('secrets.write') && providers.map((p) => (
          <MenuItem key={p.id} icon={<Cloud size={14} />} onSelect={() => setSecretDialog({ provider: p })}>
            {t('secrets.addFromProvider').replace('{provider}', providers.length > 1 ? p.label : PROVIDER_NAME[p.kind] ?? p.label)}
          </MenuItem>
        ))}
      </DropdownMenu>
    </>
  );

  return (
    <section {...sectionDrop}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
          {t('projects.resources')}
          {resources.length > 0 && <span className="tabular-nums">{resources.length}</span>}
        </h2>
        {addMenu}
      </div>

      {isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-9 rounded-md" />)}</div>
      ) : (
        <div
          className={cn(
            'overflow-hidden rounded-lg border bg-card transition-colors duration-150',
            fileOver ? 'border-dashed border-ring bg-muted/40' : 'border-border',
            resources.length === 0 && !fileOver && 'border-dashed',
          )}
        >
          {resources.length === 0 ? (
            <p className="flex items-center gap-2 px-3 py-2.5 text-[13px] text-muted-foreground">
              <FolderOpen size={14} className="shrink-0 text-faint" />
              {fileOver ? t('projects.resourcesDrop') : t('projects.resourcesEmpty')}
            </p>
          ) : resources.map((r, i) => {
            const Icon = KIND_ICON[r.kind] ?? Link2;
            const meta = r.kind === 'link' ? hostOf(r.url) : r.kind === 'file' ? fmtSize(r.file?.size) : r.kind === 'kb_page' ? t('projects.resourceKb') : '';
            const isRenaming = renaming === r.id && r.file;
            return (
              <div
                key={r.id}
                draggable={canWrite && !isRenaming}
                onDragStart={(e) => { setDragId(r.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', r.label); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overId !== r.id) setOverId(r.id);
                }}
                onDrop={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  e.stopPropagation();
                  dropOn(r.id);
                  setDragId(null);
                  setOverId(null);
                }}
                className={cn(
                  'group/res flex h-10 items-center gap-2.5 px-3 transition-colors duration-150',
                  i > 0 && 'border-t border-border/60',
                  dragId === r.id && 'opacity-40',
                  overId === r.id && dragId !== r.id && 'bg-muted/60',
                )}
              >
                {canWrite && (
                  <Tooltip label={t('projects.dragToReorder')}>
                    <span className="-ml-1.5 hidden cursor-grab text-faint opacity-0 transition-opacity duration-150 group-hover/res:opacity-100 sm:block" aria-hidden>
                      <GripVertical size={13} />
                    </span>
                  </Tooltip>
                )}
                <Icon size={15} className="shrink-0 text-muted-foreground" />
                {isRenaming ? (
                  <RenameInput
                    file={{ id: r.file!.id, filename: r.file!.filename }}
                    onSave={(filename) => renameFile.mutate({ attachmentId: r.file!.id, filename })}
                    onCancel={() => setRenaming(null)}
                    className="font-medium"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={(e) => activate(r, e)}
                    onDoubleClick={canWrite && r.kind === 'file' ? () => setRenaming(r.id) : undefined}
                    title={r.kind === 'link' ? r.url ?? undefined : r.label}
                    className="min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:underline"
                  >
                    {r.label}
                  </button>
                )}
                {meta && !isRenaming && <span className="hidden shrink-0 truncate text-xs tabular-nums text-faint sm:block">{meta}</span>}
                {r.secret && (
                  <>
                    <ExpiryHint date={r.secret.expiresAt} className="hidden shrink-0 sm:block" />
                    {r.secret.availableToAgents && (
                      <Tooltip label={t('secrets.agents')}><Bot size={13} className="hidden shrink-0 text-faint sm:block" /></Tooltip>
                    )}
                    {r.secret.provider && (
                      r.secret.provider.state === 'ok' ? (
                        <Tooltip label={r.secret.provider.label ?? ''}><Cloud size={13} className="hidden shrink-0 text-faint sm:block" /></Tooltip>
                      ) : (
                        <Tooltip label={r.secret.provider.error ?? ''}><AlertTriangle size={13} className="shrink-0 text-warning" /></Tooltip>
                      )
                    )}
                    <span className="hidden shrink-0 truncate text-xs text-faint md:block">{r.secret.fields.map((f) => f.label).join(', ')}</span>
                    <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium', ENV_TONE[r.secret.environment])}>
                      {t(`secrets.env.${r.secret.environment}`)}
                    </span>
                  </>
                )}

                {r.kind === 'file' && r.file && !isRenaming && (
                  <Tooltip label={t('crm.downloadFile')}>
                    <IconButton size="sm" aria-label={t('crm.downloadFile')} onClick={() => download(r.file!.id)}
                      className="opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/res:opacity-100">
                      <Download size={13} />
                    </IconButton>
                  </Tooltip>
                )}
                {canWrite && !isRenaming && (r.kind === 'link' || r.kind === 'file') && (
                  <Tooltip label={r.kind === 'file' ? t('crm.renameFile') : t('projects.editResourceAction')}>
                    <IconButton
                      size="sm"
                      aria-label={r.kind === 'file' ? t('crm.renameFile') : t('projects.editResourceAction')}
                      onClick={() => (r.kind === 'file' ? setRenaming(r.id) : setLinkDialog(r))}
                      className="opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/res:opacity-100"
                    >
                      <Pencil size={13} />
                    </IconButton>
                  </Tooltip>
                )}
                {/* A secret is deleted from its panel, behind a confirmation and its own access rule. */}
                {canWrite && !isRenaming && r.kind !== 'secret' && (
                  <Tooltip label={r.kind === 'file' ? t('common.delete') : r.kind === 'kb_page' ? t('projects.unpinPage') : t('projects.removeResource')}>
                    <IconButton
                      size="sm"
                      aria-label={r.kind === 'file' ? t('common.delete') : r.kind === 'kb_page' ? t('projects.unpinPage') : t('projects.removeResource')}
                      onClick={() => (r.kind === 'file' ? setToDelete(r) : remove.mutate(r.id))}
                      className="opacity-0 transition-opacity duration-150 hover:text-destructive focus-visible:opacity-100 group-hover/res:opacity-100"
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </Tooltip>
                )}
              </div>
            );
          })}
        </div>
      )}

      <LinkDialog
        projectId={projectId}
        resource={linkDialog}
        onClose={() => setLinkDialog(null)}
        onSaved={invalidate}
      />
      <SecretPanel
        secretId={openSecret}
        users={users}
        onClose={() => setOpenSecret(null)}
        onEdit={(s) => setSecretDialog(s)}
        onDeleted={invalidate}
      />
      <SecretDialog
        projectId={projectId}
        open={secretDialog !== null}
        secret={dialogSecret}
        provider={dialogProvider}
        onClose={() => setSecretDialog(null)}
        onSaved={(saved) => {
          invalidate();
          qc.invalidateQueries({ queryKey: ['project-secret', saved.id] });
          qc.invalidateQueries({ queryKey: ['project-secret-trail', saved.id] });
          if (!dialogSecret) setOpenSecret(saved.id);
        }}
      />
      <PagePickerDialog
        projectId={projectId}
        open={pagePicker}
        pinned={new Set(resources.map((r) => r.page?.id).filter((id): id is string => !!id))}
        onClose={() => setPagePicker(false)}
        onPinned={invalidate}
      />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && remove.mutate(toDelete.id)}
        title={t('crm.deleteFileTitle')}
        body={toDelete ? t('crm.deleteFileBody').replace('{name}', toDelete.label) : ''}
        confirmLabel={t('common.delete')}
        danger
        pending={remove.isPending}
      />
      {preview && <FilePreviewDialog file={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

/** Add a link (resource = 'new') or edit one. */
function LinkDialog({ projectId, resource, onClose, onSaved }: {
  projectId: string;
  resource: ProjectResource | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const editing = resource && resource !== 'new' ? resource : null;
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [openedFor, setOpenedFor] = useState<ProjectResource | 'new' | null>(null);
  if (resource !== openedFor) {
    // Reset the form each time the dialog opens for a different target.
    setOpenedFor(resource);
    setLabel(editing?.label ?? '');
    setUrl(editing?.url ?? '');
    setError(null);
  }

  const save = useMutation({
    mutationFn: (body: { label: string; url: string }) => (editing
      ? api.patch(`/project-resources/${editing.id}`, body)
      : api.post(`/projects/${projectId}/resources`, { kind: 'link', ...body })),
    onSuccess: () => { onSaved(); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const u = url.trim();
    if (!isValidUrl(u)) { setError(t('projects.resourceUrlInvalid')); return; }
    // An empty label falls back to the address's host – most links are named by where they go.
    save.mutate({ label: label.trim() || hostOf(u) || u, url: u });
  };

  return (
    <Dialog open={resource != null} onClose={onClose} title={editing ? t('projects.editResource') : t('projects.newLink')} width={420}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="resource-url">{t('projects.resourceUrl')}</label>
          <Input id="resource-url" autoFocus={!editing} value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor="resource-label">{t('projects.resourceLabel')}</label>
          <Input id="resource-label" autoFocus={!!editing} value={label} placeholder={t('projects.resourceLabelPh')} onChange={(e) => setLabel(e.target.value)} />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={save.isPending}>{save.isPending ? <Spinner /> : t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

interface SearchHit { id: string; title: string; kind: string; url: string }

/** Search the knowledge base (GET /search, pages only) and pin a hit. */
function PagePickerDialog({ projectId, open, pinned, onClose, onPinned }: {
  projectId: string; open: boolean; pinned: Set<string>; onClose: () => void; onPinned: () => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onQuery = (v: string) => {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(v.trim()), 200);
  };

  const hits = useQuery<SearchHit[]>({
    queryKey: ['kb-page-search', debounced],
    queryFn: () => api.get<{ data: SearchHit[] }>(`/search${qs({ q: debounced })}`).then((r) => r.data.filter((h) => h.kind === 'page')),
    enabled: open && debounced.length > 0,
  });

  const pin = useMutation({
    mutationFn: (kbPageId: string) => api.post(`/projects/${projectId}/resources`, { kind: 'kb_page', kbPageId }),
    onSuccess: () => { toast(t('projects.pagePinned')); onPinned(); close(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const close = () => { setQ(''); setDebounced(''); onClose(); };
  const results = (hits.data ?? []).filter((h) => !pinned.has(h.id));

  return (
    <Dialog open={open} onClose={close} title={t('projects.pickPage')} width={480}>
      <div className="space-y-2 px-4 pb-4 pt-1">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input autoFocus value={q} placeholder={t('projects.pickPagePh')} onChange={(e) => onQuery(e.target.value)} className="pl-8" />
        </div>
        <div className="max-h-72 overflow-y-auto">
          {!debounced ? (
            <p className="px-1 py-2 text-[13px] text-muted-foreground">{t('projects.pickPageHint')}</p>
          ) : hits.isLoading ? (
            <div className="space-y-1">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : results.length === 0 ? (
            <p className="px-1 py-2 text-[13px] text-muted-foreground">{t('projects.pickPageEmpty')}</p>
          ) : (
            <ul className="space-y-0.5">
              {results.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    disabled={pin.isPending}
                    onClick={() => pin.mutate(h.id)}
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
                  >
                    <BookOpen size={14} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{h.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
