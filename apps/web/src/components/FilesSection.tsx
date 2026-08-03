/**
 * Attachments for a record: presigned S3 upload (the app's standard file path,
 * PRD §14.5), list with download links, delete with confirm.
 *
 * It lived among the CRM detail building blocks while only companies, leads and
 * deals had a Files section. Nothing about it is CRM — a project keeps files the
 * same way — so it sits on its own rather than making a project page import
 * from `crm/`.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { openExternal } from '../lib/desktop';
import { UploadError, resolveFileSrc, uploadAttachment } from '../lib/uploads';
import { useT } from '../lib/i18n';
import { Button, EmptySection, IconButton, Skeleton, Spinner, Tooltip, cn, fmtDate } from './ui';
import { ConfirmDialog, toast } from './overlays';
import { FilePreviewDialog } from './FilePreview';
import { SectionHeader } from './crm/detail';

export interface FileRow { id: string; filename: string; size?: number | null; mime?: string | null; createdAt?: string }

/** Every entity type the attachments API maps to a permission. */
export type FileEntity = 'company' | 'lead' | 'deal' | 'task' | 'project';

function fmtSize(bytes?: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FilesSection({ entityType, entityId, canWrite, variant = 'section' }: {
  entityType: FileEntity; entityId: string; canWrite: boolean;
  /** `rail` renders the compact form used in the record's properties rail. */
  variant?: 'section' | 'rail';
}) {
  const t = useT();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [toDelete, setToDelete] = useState<FileRow | null>(null);
  const [preview, setPreview] = useState<FileRow | null>(null);

  const queryKey = ['attachments', entityType, entityId];
  const { data, isLoading } = useQuery<FileRow[]>({
    queryKey,
    queryFn: () => api.get<{ data: FileRow[] }>(`/attachments${qs({ entityType, entityId })}`).then((r) => r.data),
  });
  const files = data ?? [];

  /** Sequential on purpose: one clear error per file beats a burst of retries. */
  const upload = async (picked: FileList) => {
    const files = [...picked];
    setUploading(true);
    let ok = 0;
    let firstError: string | null = null;
    for (const file of files) {
      try {
        await uploadAttachment(file, { entityType, entityId });
        ok += 1;
      } catch (e) {
        const message = e instanceof UploadError ? t(e.messageKey) : e instanceof ApiError ? e.message : t('crm.uploadFailed');
        if (!firstError) firstError = files.length > 1 ? `${file.name}: ${message}` : message;
      }
    }
    setUploading(false);
    if (inputRef.current) inputRef.current.value = '';
    if (ok) qc.invalidateQueries({ queryKey });
    if (firstError) toast.error(firstError);
    else toast(ok === 1 ? t('crm.fileUploaded') : t('crm.filesUploaded').replace('{n}', String(ok)));
  };

  const download = async (f: FileRow) => {
    // The url is the signed API path; the file streams through the API.
    const res = await api.get<{ url: string }>(`/attachments/${f.id}/url`);
    openExternal(resolveFileSrc(res.url));
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
      multiple
      className="hidden"
      onChange={(e) => { if (e.target.files?.length) upload(e.target.files); }}
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

  const previewDialog = preview && <FilePreviewDialog file={preview} onClose={() => setPreview(null)} />;

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
                  onClick={() => setPreview(f)}
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
        {previewDialog}
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
              {/* The name opens the preview; the icon on the right downloads. */}
              <button onClick={() => setPreview(f)} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:underline" title={f.filename}>
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
      {previewDialog}
    </section>
  );
}
