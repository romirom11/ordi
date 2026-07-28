import { useState, type ChangeEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileJson, Upload } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, Spinner, Textarea } from '../ui';
import { Dialog, toast } from '../overlays';

interface ImportPreview {
  prospects: number;
  companiesToCreate: number;
  leadsToCreate: number;
  exclusions: number;
  matches: Array<{ name: string; action: string }>;
}

function parse(raw: string): unknown {
  return JSON.parse(raw);
}

export function ResearchImportDialog({ open, onClose, onImported }: {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [payload, setPayload] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setRaw('');
    setPreview(null);
    setPayload(null);
    setError(null);
  };
  const previewMutation = useMutation({
    mutationFn: (body: unknown) => api.post<ImportPreview>('/leads/import/preview', body),
    onSuccess: (result, body) => {
      setPayload(body);
      setPreview(result);
    },
    onError: (error) => setError(error instanceof ApiError ? error.message : t('common.error')),
  });
  const importMutation = useMutation({
    mutationFn: () => api.post('/leads/import', payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      qc.invalidateQueries({ queryKey: ['sales-activities'] });
      toast(t('crm.imported'));
      reset();
      onClose();
      onImported?.();
    },
    onError: (error) => setError(error instanceof ApiError ? error.message : t('common.error')),
  });

  const runPreview = () => {
    setError(null);
    try {
      const parsed = parse(raw);
      previewMutation.mutate(parsed);
    } catch {
      setError(t('crm.invalidJson'));
    }
  };
  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRaw(typeof reader.result === 'string' ? reader.result : '');
      setPreview(null);
      setPayload(null);
      setError(null);
    };
    reader.readAsText(file);
  };
  const summary = preview
    ? t('crm.importPreview')
      .replace('{prospects}', String(preview.prospects))
      .replace('{companies}', String(preview.companiesToCreate))
      .replace('{leads}', String(preview.leadsToCreate))
      .replace('{exclusions}', String(preview.exclusions))
    : '';

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={t('crm.importResearch')} width={660}>
      <div className="space-y-3 px-4 pb-4 pt-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[13px] text-muted-foreground">{t('crm.importPaste')}</p>
          <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted">
            <Upload size={13} />
            JSON
            <input type="file" accept="application/json,.json" className="hidden" onChange={readFile} />
          </label>
        </div>
        <Textarea
          autoFocus
          rows={14}
          value={raw}
          onChange={(event) => {
            setRaw(event.target.value);
            setPreview(null);
            setPayload(null);
          }}
          className="font-mono text-xs"
          placeholder='{"title":"Shortlist","prospects":[...]}'
        />
        {preview && (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-[13px] font-medium"><FileJson size={15} /> {summary}</div>
            <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              {preview.matches.map((match, index) => (
                <div key={`${match.name}:${index}`} className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate">{match.name}</span>
                  <span className="shrink-0 text-faint">
                    {t(`crm.importAction.${match.action}`, match.action.replaceAll('_', ' '))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => { reset(); onClose(); }}>{t('common.cancel')}</Button>
          {!preview ? (
            <Button size="sm" onClick={runPreview} disabled={!raw.trim() || previewMutation.isPending}>
              {previewMutation.isPending ? <Spinner /> : t('crm.previewImport')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => importMutation.mutate()} disabled={importMutation.isPending || preview.leadsToCreate === 0}>
              {importMutation.isPending ? <Spinner /> : t('crm.confirmImport')}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
