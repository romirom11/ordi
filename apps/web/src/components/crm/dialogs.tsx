/**
 * CRM create/edit dialogs: new client, new deal, add contact, lost-reason prompt.
 * All use the shared Dialog overlay + toast feedback (no native alert/confirm).
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, Input, Select, Spinner } from '../ui';
import { Dialog, toast } from '../overlays';
import { CURRENCIES, COMPANY_STATUSES, useCompanies, useDealStages, type Company, type Stage } from './shared';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

export function NewClientDialog({ open, onClose, onCreated }: {
  open: boolean; onClose: () => void; onCreated?: (c: Company) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [status, setStatus] = useState<string>('lead');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setName(''); setDomain(''); setStatus('lead'); setCurrency('USD'); setError(null); };

  const mut = useMutation({
    mutationFn: () => api.post<Company>('/companies', {
      name: name.trim(), domain: domain.trim() || undefined, status, defaultCurrency: currency,
    }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast(t('crm.clientCreated'));
      reset();
      onClose();
      onCreated?.(c);
    },
    onError: (e) => setError(errMsg(e, t('crm.createFailed'))),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError(t('common.nameRequired')); return; }
    mut.mutate();
  };

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={t('crm.newClient')} width={440}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <Field label={t('common.name')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." />
        </Field>
        <Field label={t('crm.colDomain')}>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('common.status')}>
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full">
              {COMPANY_STATUSES.map((s) => <option key={s} value={s}>{t(`crm.status.${s}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('common.currency')}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => { reset(); onClose(); }}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : t('common.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function NewDealDialog({ open, onClose, lockedCompanyId, defaultStageId, onCreated }: {
  open: boolean; onClose: () => void; lockedCompanyId?: string; defaultStageId?: string; onCreated?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const stagesQ = useDealStages();
  const companiesQ = useCompanies();
  const stages = stagesQ.data ?? [];
  const companies = companiesQ.data ?? [];

  const [title, setTitle] = useState('');
  const [companyId, setCompanyId] = useState(lockedCompanyId ?? '');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [stageId, setStageId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Keep controlled defaults in sync once data / props resolve.
  const effectiveStage = stageId || defaultStageId || stages[0]?.id || '';
  const effectiveCompany = lockedCompanyId ?? companyId;

  const reset = () => { setTitle(''); setCompanyId(lockedCompanyId ?? ''); setAmount(''); setCurrency('USD'); setStageId(''); setError(null); };

  const mut = useMutation({
    mutationFn: () => api.post('/deals', {
      companyId: effectiveCompany,
      title: title.trim(),
      stageId: effectiveStage || undefined,
      amount: amount ? Number(amount) : undefined,
      currency,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['deals'] });
      toast(t('crm.dealCreated'));
      reset();
      onClose();
      onCreated?.();
    },
    onError: (e) => setError(errMsg(e, t('deals.createFailed'))),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) { setError(t('common.titleRequired')); return; }
    if (!effectiveCompany) { setError(t('crm.client') + ' — ' + t('common.select')); return; }
    mut.mutate();
  };

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={t('crm.newDeal')} width={440}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <Field label={t('common.title')}>
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Website redesign" />
        </Field>
        {!lockedCompanyId && (
          <Field label={t('crm.client')}>
            <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-full">
              <option value="">{companiesQ.isLoading ? t('common.loading') : t('common.select')}</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('public.amount')}>
            <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label={t('common.currency')}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
        </div>
        <Field label={t('deals.stage')}>
          <Select value={effectiveStage} onChange={(e) => setStageId(e.target.value)} className="w-full">
            {stages.map((s: Stage) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => { reset(); onClose(); }}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : t('common.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function AddContactDialog({ open, onClose, companyId }: {
  open: boolean; onClose: () => void; companyId: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setFirst(''); setLast(''); setEmail(''); setPhone(''); setPosition(''); setError(null); };

  const mut = useMutation({
    mutationFn: () => api.post('/contacts', {
      companyId, firstName: first.trim(), lastName: last.trim() || undefined,
      email: email.trim() || undefined, phone: phone.trim() || undefined, position: position.trim() || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts', companyId] });
      toast(t('common.saved'));
      reset();
      onClose();
    },
    onError: (e) => setError(errMsg(e, t('crm.addContactFailed'))),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!first.trim()) { setError(t('crm.firstNameRequired')); return; }
    mut.mutate();
  };

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={t('crm.addContact')} width={440}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('crm.firstName')}>
            <Input autoFocus value={first} onChange={(e) => setFirst(e.target.value)} />
          </Field>
          <Field label={t('crm.lastName')}>
            <Input value={last} onChange={(e) => setLast(e.target.value)} />
          </Field>
        </div>
        <Field label={t('crm.position')}>
          <Input value={position} onChange={(e) => setPosition(e.target.value)} placeholder="CEO" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('auth.email')}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t('crm.phone')}>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => { reset(); onClose(); }}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : t('common.add')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function LostReasonDialog({ open, onClose, onConfirm, pending }: {
  open: boolean; onClose: () => void; onConfirm: (reason: string) => void; pending?: boolean;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  return (
    <Dialog open={open} onClose={onClose} title={t('crm.lostReasonTitle')} width={420}>
      <form
        onSubmit={(e) => { e.preventDefault(); onConfirm(reason.trim()); setReason(''); }}
        className="space-y-3 px-4 pb-4 pt-1"
      >
        <Field label={t('crm.lostReasonLabel')}>
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('crm.lostReasonPlaceholder')} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="destructive" size="sm" disabled={pending}>{pending ? <Spinner /> : t('crm.markLost')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
