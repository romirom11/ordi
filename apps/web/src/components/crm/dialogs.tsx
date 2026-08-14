/**
 * CRM create/edit dialogs: new client, new deal, add contact, lost-reason prompt.
 * All use the shared Dialog overlay + toast feedback (no native alert/confirm).
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, FolderKanban, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, Input, Spinner } from '../ui';
import { Dialog, toast } from '../overlays';
import { SearchSelect } from '../SearchSelect';
import {
  CURRENCIES, COMPANY_STATUSES, NEW_LEAD_STATUSES, StatusPill, useCompanies, useDealStages,
  useProjectsLookup, type Company, type Stage,
} from './shared';
import { CustomFieldsSection } from './CustomFieldsSection';
import { byName } from '../../lib/queries';

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
            <SearchSelect
              className="w-full"
              value={status}
              onChange={setStatus}
              options={COMPANY_STATUSES.map((s) => ({ value: s, label: t(`crm.status.${s}`), render: <StatusPill status={s} /> }))}
            />
          </Field>
          <Field label={t('common.currency')}>
            <SearchSelect
              className="w-full"
              width={140}
              value={currency}
              onChange={setCurrency}
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            />
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

const NEW_COMPANY = '__new__';

export function NewLeadDialog({ open, onClose, lockedCompanyId, onCreated }: {
  open: boolean;
  onClose: () => void;
  lockedCompanyId?: string;
  onCreated?: (lead: { id: string }) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const companiesQ = useCompanies();
  const [companyId, setCompanyId] = useState(lockedCompanyId ?? '');
  const [newCompanyName, setNewCompanyName] = useState('');
  const [title, setTitle] = useState('');
  const [product, setProduct] = useState('');
  const [status, setStatus] = useState<string>('new');
  const [error, setError] = useState<string | null>(null);
  /** Sentinel option: the prospect is not in the workspace yet. */
  const creatingCompany = !lockedCompanyId && companyId === NEW_COMPANY;
  const effectiveCompany = lockedCompanyId ?? companyId;

  const reset = () => {
    setCompanyId(lockedCompanyId ?? '');
    setNewCompanyName('');
    setTitle('');
    setProduct('');
    setStatus('new');
    setError(null);
  };

  const mut = useMutation({
    /**
     * A lead almost always arrives before its company does, and the form used to
     * dead-end there: pick from a list, or cancel and go build the company on
     * another tab. Creating it inline keeps the one action a seller performs
     * most often to a single pass.
     */
    mutationFn: async () => {
      const targetCompany = creatingCompany
        ? (await api.post<{ id: string }>('/companies', {
          name: newCompanyName.trim(),
          status: 'lead',
        })).id
        : effectiveCompany;
      return api.post<{ id: string }>('/leads', {
        companyId: targetCompany,
        title: title.trim(),
        product: product.trim() || undefined,
        status,
      });
    },
    onSuccess: (lead) => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      toast(t('crm.leadCreated'));
      reset();
      onClose();
      onCreated?.(lead);
    },
    onError: (e) => setError(errMsg(e, t('common.error'))),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!effectiveCompany) { setError(t('crm.company') + ' – ' + t('common.select')); return; }
    if (creatingCompany && !newCompanyName.trim()) { setError(t('crm.companyNameRequired')); return; }
    if (!title.trim()) { setError(t('common.titleRequired')); return; }
    mut.mutate();
  };

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={t('crm.newLead')} width={440}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        {!lockedCompanyId && (
          <Field label={t('crm.company')}>
            <SearchSelect
              className="w-full"
              value={companyId}
              onChange={setCompanyId}
              placeholder={companiesQ.isLoading ? t('common.loading') : t('common.select')}
              options={[
                { value: NEW_COMPANY, label: t('crm.newCompanyOption'), icon: <Plus size={14} /> },
                ...byName(companiesQ.data).map((company) => ({
                  value: company.id, label: company.name, icon: <Building2 size={14} />,
                })),
              ]}
            />
          </Field>
        )}
        {creatingCompany && (
          <Field label={t('crm.companyName')}>
            <Input
              autoFocus
              value={newCompanyName}
              onChange={(e) => setNewCompanyName(e.target.value)}
              placeholder="Northwind Traders"
            />
          </Field>
        )}
        <Field label={t('common.title')}>
          <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme — workflow pilot" />
        </Field>
        <Field label={t('crm.product')}>
          <Input value={product} onChange={(e) => setProduct(e.target.value)} placeholder="AI / workflow pilot" />
        </Field>
        <Field label={t('common.status')}>
          <SearchSelect
            className="w-full"
            value={status}
            onChange={setStatus}
            options={NEW_LEAD_STATUSES.map((value) => ({
              value, label: t(`crm.status.${value}`), render: <StatusPill status={value} />,
            }))}
          />
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

export function NewDealDialog({ open, onClose, lockedCompanyId, defaultStageId, onCreated }: {
  open: boolean; onClose: () => void; lockedCompanyId?: string; defaultStageId?: string; onCreated?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const stagesQ = useDealStages();
  const companiesQ = useCompanies();
  const projectsQ = useProjectsLookup();
  const stages = stagesQ.data ?? [];
  const companies = companiesQ.data ?? [];
  const projects = projectsQ.data ?? [];

  const [title, setTitle] = useState('');
  const [companyId, setCompanyId] = useState(lockedCompanyId ?? '');
  const [projectId, setProjectId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [stageId, setStageId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Keep controlled defaults in sync once data / props resolve.
  const effectiveStage = stageId || defaultStageId || stages[0]?.id || '';
  const effectiveCompany = lockedCompanyId ?? companyId;

  const reset = () => { setTitle(''); setCompanyId(lockedCompanyId ?? ''); setProjectId(''); setAmount(''); setCurrency('USD'); setStageId(''); setError(null); };

  const mut = useMutation({
    mutationFn: () => api.post('/deals', {
      companyId: effectiveCompany,
      projectId: projectId || undefined,
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
    if (!effectiveCompany) { setError(t('crm.client') + ' – ' + t('common.select')); return; }
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
            <SearchSelect
              className="w-full"
              value={companyId}
              onChange={setCompanyId}
              placeholder={companiesQ.isLoading ? t('common.loading') : t('common.select')}
              options={byName(companies).map((c) => ({ value: c.id, label: c.name, icon: <Building2 size={14} /> }))}
            />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('public.amount')}>
            <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label={t('common.currency')}>
            <SearchSelect
              className="w-full"
              width={140}
              value={currency}
              onChange={setCurrency}
              options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            />
          </Field>
        </div>
        <Field label={t('deals.stage')}>
          <SearchSelect
            className="w-full"
            value={effectiveStage}
            onChange={setStageId}
            options={stages.map((s: Stage) => ({ value: s.id, label: s.name }))}
          />
        </Field>
        {projects.length > 0 && (
          <Field label={`${t('crm.project')} · ${t('crm.linkProjectHint')}`}>
            <SearchSelect
              className="w-full"
              value={projectId}
              onChange={setProjectId}
              options={[
                { value: '', label: t('crm.noProject') },
                ...projects.map((p) => ({
                  value: p.id, label: p.name, hint: p.key ?? undefined, icon: <FolderKanban size={14} />,
                })),
              ]}
            />
          </Field>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => { reset(); onClose(); }}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : t('common.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Create or edit a contact: pass `contact` to edit, omit it to create. */
export function ContactDialog({ open, onClose, companyId, contact, onCreated }: {
  open: boolean; onClose: () => void; companyId: string;
  contact?: { id: string; firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null; position?: string | null; customFields?: Record<string, unknown> };
  /** Fired only on create, so a lead can attach the contact it just made. */
  onCreated?: (created: { id: string }) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  // Contacts have no detail page, so custom fields are drafted here and
  // submitted with the rest of the form – not saved per keystroke.
  const [cf, setCf] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);

  // Prefill from the contact being edited each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setFirst(contact?.firstName ?? '');
    setLast(contact?.lastName ?? '');
    setEmail(contact?.email ?? '');
    setPhone(contact?.phone ?? '');
    setPosition(contact?.position ?? '');
    setCf(contact?.customFields ?? {});
    setError(null);
  }, [open, contact]);

  const reset = () => { setFirst(''); setLast(''); setEmail(''); setPhone(''); setPosition(''); setCf({}); setError(null); };

  const mut = useMutation({
    mutationFn: () => {
      const body = {
        firstName: first.trim(), lastName: last.trim() || (contact ? '' : undefined),
        email: email.trim() || null, phone: phone.trim() || null, position: position.trim() || null,
        customFields: cf,
      };
      return contact
        ? api.patch(`/contacts/${contact.id}`, body).then(() => null)
        : api.post<{ id: string }>('/contacts', { companyId, ...body, email: body.email ?? undefined, phone: body.phone ?? undefined, position: body.position ?? undefined });
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['contacts', companyId] });
      toast(t('common.saved'));
      reset();
      onClose();
      if (created) onCreated?.(created);
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
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={contact ? t('crm.editContact') : t('crm.addContact')} width={440}>
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
        <CustomFieldsSection entityType="contacts" values={cf} editable onSave={setCf} />
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => { reset(); onClose(); }}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : contact ? t('common.save') : t('common.add')}</Button>
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
