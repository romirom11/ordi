import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Download, Upload, CheckCircle2, AlertCircle, FileUp } from 'lucide-react';
import { api, ApiError, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { useT, extendDict } from '../lib/i18n';
import { Button, Select, Textarea, cn } from './ui';
import { DateField } from './DatePicker';
import { SectionHead, Disclosure } from './settings/primitives';
import { toast } from './overlays';

/** CSV import/export (PRD §14.6): exports per domain permission; imports with dry-run. */

extendDict({
  en: {
    'importexport.companies': 'Companies',
    'importexport.contacts': 'Contacts',
    'importexport.leads': 'Leads',
    'importexport.tasks': 'Tasks',
    'importexport.invoices': 'Invoices',
    'importexport.time': 'Time entries',
    'importexport.timePeriod': 'Time entries for',
    'importexport.from': 'From',
    'importexport.to': 'To',
    'importexport.allTime': 'Leave the dates empty for all time.',
    'importexport.chooseFile': 'Choose file',
    'importexport.fileTooBig': 'The file is larger than 5 MB – split it into smaller files.',
    'importexport.updateHint': 'A row with the {col} of an existing record updates it; edit an export and import it back. Comma- or semicolon-separated.',
    'importexport.result': '{created} new, {updated} updated',
    'importexport.newCompanies': '{n} companies will be created',
    'importexport.line': 'Line {n}',
    'importexport.moreErrors': '…and {n} more',
  },
  uk: {
    'importexport.companies': 'Компанії',
    'importexport.contacts': 'Контакти',
    'importexport.leads': 'Ліди',
    'importexport.tasks': 'Задачі',
    'importexport.invoices': 'Рахунки',
    'importexport.time': 'Записи часу',
    'importexport.timePeriod': 'Записи часу за',
    'importexport.from': 'З',
    'importexport.to': 'По',
    'importexport.allTime': 'Без дат – за весь час.',
    'importexport.chooseFile': 'Вибрати файл',
    'importexport.fileTooBig': 'Файл більший за 5 МБ – розбийте його на менші.',
    'importexport.updateHint': 'Рядок з {col} наявного запису оновлює його: можна відредагувати експорт і завантажити назад. Розділювач – кома або крапка з комою.',
    'importexport.result': 'нових: {created}, оновлено: {updated}',
    'importexport.newCompanies': 'Буде створено компаній: {n}',
    'importexport.line': 'Рядок {n}',
    'importexport.moreErrors': '…і ще {n}',
  },
});

const EXPORTS: { path: string; label: string; perm: string }[] = [
  { path: '/export/companies.csv', label: 'importexport.companies', perm: 'crm.export' },
  { path: '/export/contacts.csv', label: 'importexport.contacts', perm: 'crm.export' },
  { path: '/export/leads.csv', label: 'importexport.leads', perm: 'crm.export' },
  { path: '/export/tasks.csv', label: 'importexport.tasks', perm: 'projects.export' },
  { path: '/export/invoices.csv', label: 'importexport.invoices', perm: 'finance.export' },
];

const IMPORT_TARGETS = [
  { key: 'companies', label: 'importexport.companies', perm: 'crm.write', idCol: 'id', hint: 'id,name,domain,status,billingEmail,defaultCurrency,paymentTermsDays' },
  { key: 'contacts', label: 'importexport.contacts', perm: 'crm.write', idCol: 'id', hint: 'id,companyName,firstName,lastName,email,phone,position' },
  // Unknown companyName values are created as prospect companies on the fly.
  { key: 'leads', label: 'importexport.leads', perm: 'crm.write', idCol: 'id', hint: 'id,companyName,title,product,status,score,signal,painSignal,evidence,whyFit,whyNow,sourceTitle,sourceUrl,sourceType,signalDate,suggestedChannel,opener,caution' },
  { key: 'tasks', label: 'importexport.tasks', perm: 'projects.create', idCol: 'ref', hint: 'ref,projectKey,title,status,priority,startDate,dueDate,estimate' },
] as const;

/** The API takes the CSV as a JSON string; past this a request is better split. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface ImportResult {
  rows?: number;
  valid?: number;
  created?: number;
  updated?: number;
  imported?: number;
  newCompanies?: number;
  errors?: { line: number; message: string }[];
}

export function ImportExportPanel() {
  const can = useCan();
  const t = useT();
  const [target, setTarget] = useState<string>('companies');
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [wasDryRun, setWasDryRun] = useState(true);
  const [timeFrom, setTimeFrom] = useState<string | null>(null);
  const [timeTo, setTimeTo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const targetDef = IMPORT_TARGETS.find((i) => i.key === target) ?? IMPORT_TARGETS[0];
  const visibleExports = EXPORTS.filter((e) => can(e.perm));
  const canExportTime = can('time.read_all');
  const visibleImports = IMPORT_TARGETS.filter((i) => can(i.perm));

  const download = (path: string, filename: string) =>
    // Through fetch, not <a href>: a navigation carries the cookie but not the
    // desktop app's bearer token, so the link answered 401 there.
    api.download(path, filename).catch((err) => toast.error(err instanceof ApiError ? err.message : t('crm.exportFailed', 'Export failed')));

  const run = useMutation({
    mutationFn: (dryRun: boolean) => {
      setWasDryRun(dryRun);
      return api.post<ImportResult>(`/import/${targetDef.key}`, { csv, dryRun });
    },
    // The mutation's own argument, not the wasDryRun state: this callback was
    // created before setWasDryRun landed, so it read the previous run's mode
    // and toasted "Imported" after a dry run (and stayed silent after an import).
    onSuccess: (r, dryRun) => { setResult(r); if (!dryRun) toast(t('importexport.imported', 'Imported')); },
    onError: (e: Error) => { setResult({ errors: [{ line: 0, message: e.message }] }); toast.error(e.message); },
  });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { toast.error(t('importexport.fileTooBig')); return; }
    setCsv(await file.text());
    setResult(null);
  };

  const errors = result?.errors ?? [];
  const hasErrors = errors.length > 0;
  const counts = t('importexport.result')
    .replace('{created}', String(result?.created ?? 0))
    .replace('{updated}', String(result?.updated ?? 0));

  return (
    <div className="space-y-4">
      <SectionHead title={t('settings.importExport', 'Import & export')} desc={t('settings.importExportDesc', 'Bulk import and export via CSV.')} />

      {/* Export: one click per file – the everyday half of this page. */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold"><Download size={15} /> {t('importexport.export', 'Export CSV')}</div>
        {visibleExports.length === 0 && !canExportTime ? (
          <p className="text-[13px] text-muted-foreground">{t('common.noAccess')}</p>
        ) : (
          <div className="space-y-3">
            {visibleExports.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {visibleExports.map((e) => (
                  <Button key={e.path} variant="outline" onClick={() => download(e.path, e.path.split('/').pop()!)}>
                    <Download size={14} className="text-muted-foreground" /> {t(e.label)}
                  </Button>
                ))}
              </div>
            )}
            {/* Time grows without bound, so it can be cut to a period. */}
            {canExportTime && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <span className="text-[13px] text-muted-foreground">{t('importexport.timePeriod')}</span>
                <div className="w-36"><DateField size="sm" value={timeFrom} onChange={setTimeFrom} max={timeTo ?? undefined} placeholder={t('importexport.from')} aria-label={t('importexport.from')} /></div>
                <span className="text-faint">–</span>
                <div className="w-36"><DateField size="sm" value={timeTo} onChange={setTimeTo} min={timeFrom ?? undefined} placeholder={t('importexport.to')} aria-label={t('importexport.to')} /></div>
                <Button variant="outline" onClick={() => download(`/export/time.csv${qs({ from: timeFrom, to: timeTo })}`, 'time.csv')}>
                  <Download size={14} className="text-muted-foreground" /> {t('importexport.time')}
                </Button>
                <span className="text-xs text-faint">{t('importexport.allTime')}</span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Import */}
      {visibleImports.length > 0 && (
        <section className="rounded-lg border border-border bg-card p-4">
          <Disclosure label={<span className="inline-flex items-center gap-2 font-semibold text-foreground"><Upload size={15} /> {t('importexport.import', 'Import CSV')}</span>}>
          <div className="space-y-3 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={target} onChange={(e) => { setTarget(e.target.value); setResult(null); }} className="w-40">
                {visibleImports.map((i) => <option key={i.key} value={i.key}>{t(i.label)}</option>)}
              </Select>
              <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                <FileUp size={14} className="text-muted-foreground" /> {t('importexport.chooseFile')}
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                className="hidden"
                onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {t('importexport.columns', 'Columns')}: <code className="break-all rounded bg-muted px-1 font-mono text-[11px]">{targetDef.hint}</code>
            </p>
            <p className="text-xs text-muted-foreground">
              {t('importexport.updateHint').replace('{col}', targetDef.idCol)}
            </p>
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
                  {result.rows === undefined
                    ? t('common.saveFailed')
                    : wasDryRun
                      ? `${t('importexport.dryRunResult', 'Dry run')}: ${result.valid ?? 0}/${result.rows} ${t('importexport.validRows', 'valid rows')} · ${counts}`
                      : `${t('importexport.imported', 'Imported')}: ${counts}`}
                </p>
                {!!result.newCompanies && (
                  <p className="mt-1 text-xs text-muted-foreground">{t('importexport.newCompanies').replace('{n}', String(result.newCompanies))}</p>
                )}
                {hasErrors && (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-destructive">
                    {errors.slice(0, 10).map((er, i) => (
                      <li key={i}>{er.line > 0 ? `${t('importexport.line').replace('{n}', String(er.line))}: ` : ''}{er.message}</li>
                    ))}
                    {errors.length > 10 && <li>{t('importexport.moreErrors').replace('{n}', String(errors.length - 10))}</li>}
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
