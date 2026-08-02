import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, Upload, CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Button, Select, Textarea, cn } from './ui';
import { SectionHead, Disclosure } from './settings/primitives';
import { toast } from './overlays';

/** CSV import/export (PRD §14.6): exports per domain permission; imports with dry-run. */

const EXPORTS: { path: string; label: string; perm: string }[] = [
  { path: '/api/v1/export/companies.csv', label: 'Companies', perm: 'crm.export' },
  { path: '/api/v1/export/contacts.csv', label: 'Contacts', perm: 'crm.export' },
  { path: '/api/v1/export/leads.csv', label: 'Leads', perm: 'crm.export' },
  { path: '/api/v1/export/tasks.csv', label: 'Tasks', perm: 'projects.export' },
  { path: '/api/v1/export/invoices.csv', label: 'Invoices', perm: 'finance.export' },
  { path: '/api/v1/export/time.csv', label: 'Time entries', perm: 'time.read_all' },
];

const IMPORT_TARGETS = [
  { key: 'companies', label: 'Companies', perm: 'crm.write', hint: 'name,domain,status,billingEmail,defaultCurrency' },
  { key: 'contacts', label: 'Contacts', perm: 'crm.write', hint: 'companyName,firstName,lastName,email,phone' },
  // Unknown companyName values are created as prospect companies on the fly.
  { key: 'leads', label: 'Leads', perm: 'crm.write', hint: 'companyName,title,product,status,score,signal,sourceUrl,suggestedChannel,opener' },
  { key: 'tasks', label: 'Tasks', perm: 'projects.create', hint: 'projectKey,title,priority' },
] as const;

interface ImportResult {
  rows?: number;
  valid?: number;
  imported?: number;
  errors?: { line: number; message: string }[];
}

export function ImportExportPanel() {
  const can = useCan();
  const t = useT();
  const [target, setTarget] = useState<string>('companies');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [wasDryRun, setWasDryRun] = useState(true);

  const targetDef = IMPORT_TARGETS.find((i) => i.key === target) ?? IMPORT_TARGETS[0];
  const visibleExports = EXPORTS.filter((e) => can(e.perm));
  const visibleImports = IMPORT_TARGETS.filter((i) => can(i.perm));

  const run = useMutation({
    mutationFn: (dryRun: boolean) => {
      setWasDryRun(dryRun);
      return api.post<ImportResult>(`/import/${targetDef.key}`, { csv, dryRun });
    },
    onSuccess: (r) => { setResult(r); if (!wasDryRun) toast(t('importexport.imported', 'Imported')); },
    onError: (e: Error) => { setResult({ errors: [{ line: 0, message: e.message }] }); toast.error(e.message); },
  });

  const hasErrors = (result?.errors ?? []).length > 0;

  return (
    <div className="space-y-8">
      <SectionHead title={t('settings.importExport', 'Import & export')} desc={t('settings.importExportDesc', 'Bulk import and export via CSV.')} />

      {/* Export: one click per file – the everyday half of this page. */}
      <section>
        <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold"><Download size={15} /> {t('importexport.export', 'Export CSV')}</div>
        {visibleExports.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('common.noAccess')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {visibleExports.map((e) => (
              <a key={e.path} href={e.path}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[13px] transition-colors hover:border-border-strong hover:bg-muted">
                <Download size={14} className="text-muted-foreground" /> {e.label}
              </a>
            ))}
          </div>
        )}
      </section>

      {/* Import */}
      {visibleImports.length > 0 && (
        <section>
          <Disclosure label={<span className="inline-flex items-center gap-2 font-semibold text-foreground"><Upload size={15} /> {t('importexport.import', 'Import CSV')}</span>}>
          <div className="space-y-3 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={target} onChange={(e) => { setTarget(e.target.value); setResult(null); }} className="w-40">
                {visibleImports.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
              </Select>
              <span className="text-xs text-muted-foreground">{t('importexport.columns', 'Columns')}: <code className="rounded bg-muted px-1 font-mono text-[11px]">{targetDef.hint}</code></span>
            </div>
            <Textarea rows={6} value={csv} onChange={(e) => setCsv(e.target.value)}
              placeholder={`${targetDef.hint}\n…`} className="font-mono text-[11px]" />
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={!csv.trim() || run.isPending} onClick={() => run.mutate(true)}>
                {t('importexport.dryRun', 'Dry run')}
              </Button>
              <Button size="sm" disabled={!csv.trim() || run.isPending} onClick={() => run.mutate(false)}>
                {t('importexport.apply', 'Import')}
              </Button>
            </div>
            {result && (
              <div className={cn('rounded-md border px-3 py-2.5 text-[13px]', hasErrors ? 'border-destructive/30 bg-destructive/5' : 'border-success/30 bg-success/5')}>
                <p className="flex items-center gap-1.5 font-medium">
                  {hasErrors ? <AlertCircle size={14} className="text-destructive" /> : <CheckCircle2 size={14} className="text-success" />}
                  {wasDryRun
                    ? `${t('importexport.dryRunResult', 'Dry run')}: ${result.valid ?? 0}/${result.rows ?? 0} ${t('importexport.validRows', 'valid rows')}`
                    : `${t('importexport.imported', 'Imported')}: ${result.imported ?? 0}`}
                </p>
                {hasErrors && (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-destructive">
                    {(result.errors ?? []).slice(0, 10).map((er, i) => (
                      <li key={i}>{er.line > 0 ? `Line ${er.line}: ` : ''}{er.message}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
          </Disclosure>
        </section>
      )}
    </div>
  );
}
