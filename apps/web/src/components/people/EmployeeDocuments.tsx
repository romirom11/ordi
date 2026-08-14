/**
 * Employee documents (PRD §12.1): contracts, IDs, certificates. Files ride the
 * generic attachments pipeline; the employee_documents table binds them to the
 * card. PDFs (and images/text) open right here via FilePreviewDialog; anything
 * else falls back to download. Upload/delete need people.write.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { uploadAttachment, uploadErrorKey } from '../../lib/uploads';
import { useT, extendDict } from '../../lib/i18n';
import { Button, Skeleton, fmtDate } from '../ui';
import { ConfirmDialog, toast } from '../overlays';
import { FilePreviewDialog } from '../FilePreview';
import type { FileRow } from '../FilesSection';

extendDict({
  en: {
    'people.documents': 'Documents',
    'people.addDocument': 'Add document',
    'people.noDocuments': 'No documents yet.',
    'people.docDeleteTitle': 'Remove document?',
    'people.docDeleteBody': 'The document is detached from this employee. This cannot be undone.',
    'people.docUploadFailed': 'Could not upload the document.',
  },
  uk: {
    'people.documents': 'Документи',
    'people.addDocument': 'Додати документ',
    'people.noDocuments': 'Ще немає документів.',
    'people.docDeleteTitle': 'Прибрати документ?',
    'people.docDeleteBody': 'Документ буде відв’язано від співробітника. Цю дію не можна скасувати.',
    'people.docUploadFailed': 'Не вдалося завантажити документ.',
  },
});

interface DocRow {
  id: string; attachmentId: string; type?: string | null; createdAt?: string | null;
  filename?: string | null; size?: number | null; mime?: string | null;
}

function fmtSize(bytes?: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function EmployeeDocuments({ employeeId, canWrite }: { employeeId: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<FileRow | null>(null);
  const [deleting, setDeleting] = useState<DocRow | null>(null);
  const [uploading, setUploading] = useState(false);

  const docsQ = useQuery({
    queryKey: ['employeeDocuments', employeeId],
    queryFn: () => api.get<{ data: DocRow[] }>(`/employees/${employeeId}/documents`),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['employeeDocuments', employeeId] });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      // Bound to the employee from the first byte – an entity-less attachment
      // would hand its signed URL to any authenticated user.
      const up = await uploadAttachment(file, { entityType: 'employee', entityId: employeeId });
      await api.post(`/employees/${employeeId}/documents`, { attachmentId: up.id });
      invalidate();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t(uploadErrorKey(e)) || t('people.docUploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/employee-documents/${id}`),
    onSuccess: () => { setDeleting(null); invalidate(); },
    onError: (e) => { setDeleting(null); toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')); },
  });

  const docs = docsQ.data?.data ?? [];

  return (
    <section className="mb-6">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-faint">{t('people.documents')}</h2>
        {canWrite && (
          <>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }}
            />
            <Button size="xs" variant="outline" disabled={uploading} onClick={() => inputRef.current?.click()}>
              <Plus size={13} /> {t('people.addDocument')}
            </Button>
          </>
        )}
      </div>
      {docsQ.isLoading ? (
        <Skeleton className="h-14 w-full rounded-xl" />
      ) : docs.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card px-4 py-5 text-center text-[13px] text-muted-foreground">
          {t('people.noDocuments')}
        </div>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {docs.map((d) => (
            <div key={d.id} className="group flex items-center gap-3 px-4 py-2.5 text-[13px]">
              <FileText size={15} className="shrink-0 text-faint" />
              <button
                className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                onClick={() => setPreview({ id: d.attachmentId, filename: d.filename ?? '–', size: d.size, mime: d.mime })}
              >
                {d.filename ?? '–'}
              </button>
              <span className="shrink-0 text-xs text-faint">{fmtSize(d.size)}</span>
              {d.createdAt && <span className="hidden shrink-0 text-xs text-faint sm:block">{fmtDate(d.createdAt)}</span>}
              {canWrite && (
                <button
                  title={t('common.delete')}
                  onClick={() => setDeleting(d)}
                  className="shrink-0 rounded-md p-1 text-faint opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {preview && <FilePreviewDialog file={preview} onClose={() => setPreview(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && del.mutate(deleting.id)}
        title={t('people.docDeleteTitle')}
        body={t('people.docDeleteBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </section>
  );
}
