/**
 * Add or edit a project secret: one paste of what the client sent becomes
 * fields, the audience picker shows who will really be able to open the
 * values, and agent use is a deliberate switch.
 *
 * Editing never loads a value: a secret field left empty keeps what is
 * stored, so values travel to the browser only through Show and Copy.
 *
 * A provider secret (Doppler) is the same dialog with no values at all: each
 * field picks the provider secret it reads, from the names of a connection
 * linked to the project.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, ClipboardPaste, Plus, Users, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useCan, useMe } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { pasteToFields, fieldKeyFor } from '../../lib/pasteToFields';
import { Avatar, Button, IconButton, Input, SegmentedControl, Select, Spinner, Switch, Textarea, cn } from '../ui';
import { Dialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { DateField } from '../DatePicker';
import { SearchSelect } from '../SearchSelect';
import {
  ENV_DOT, PROVIDER_NAME, SECRET_ENVIRONMENTS, SECRET_FIELD_TYPES, fieldFromRef, isSecretValueType,
  type AudiencePrincipal, type ProviderConnection, type SecretEnvironment, type SecretFieldType, type SecretView,
} from './secretsShared';

interface FieldDraft {
  /** Stable for React; the stored key for existing fields. */
  id: string;
  key: string;
  label: string;
  type: SecretFieldType;
  value: string;
  /** Existing field: an empty value means "keep". */
  existing: boolean;
  hasValue: boolean;
  /** Provider secrets: the provider name the field reads. */
  ref: string;
}

interface AudienceOptions {
  people: { id: string; name: string; avatar: string | null }[];
  departments: { id: string; name: string; parentId: string | null }[];
}

let draftSeq = 0;
const nextId = () => `f${++draftSeq}`;

function draftsFrom(secret: SecretView | null, fromProvider: boolean): FieldDraft[] {
  if (!secret) {
    if (fromProvider) return [{ id: nextId(), key: 'value', label: '', type: 'api_key', value: '', existing: false, hasValue: false, ref: '' }];
    return [
      { id: nextId(), key: 'login', label: '', type: 'text', value: '', existing: false, hasValue: false, ref: '' },
      { id: nextId(), key: 'password', label: '', type: 'password', value: '', existing: false, hasValue: false, ref: '' },
    ];
  }
  return secret.fields.map((f) => ({
    id: nextId(), key: f.key, label: f.label, type: f.type,
    // Plain fields come back in the clear and are edited in place; secret ones start empty (= keep).
    value: isSecretValueType(f.type) ? '' : f.value ?? '',
    existing: true, hasValue: f.hasValue, ref: f.ref ?? '',
  }));
}

/** A provider name as an ordi secret name: upper snake case, no double underscores. */
function nameFromRef(ref: string): string {
  const name = ref.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_').replace(/^[^A-Z]+/, '').replace(/_$/, '');
  return name.slice(0, 64);
}

function uniqueKeys(fields: FieldDraft[]): FieldDraft[] {
  const seen = new Set<string>();
  return fields.map((f) => {
    let key = f.key;
    for (let n = 2; seen.has(key); n++) key = `${f.key}_${n}`.slice(0, 32);
    seen.add(key);
    return key === f.key ? f : { ...f, key };
  });
}

export function SecretDialog({ projectId, secret, provider, open, onClose, onSaved }: {
  projectId: string;
  /** null: add a new secret. */
  secret: SecretView | null;
  /** A new secret read from this connection (Resources → Add → From Doppler). */
  provider?: ProviderConnection | null;
  open: boolean;
  onClose: () => void;
  onSaved: (saved: SecretView) => void;
}) {
  const t = useT();
  const me = useMe();
  const can = useCan();
  const canManage = can('secrets.manage');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [environment, setEnvironment] = useState<SecretEnvironment>('test');
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [agents, setAgents] = useState(false);
  const [audience, setAudience] = useState<AudiencePrincipal[]>([{ type: 'project' }]);
  const [fields, setFields] = useState<FieldDraft[]>(() => draftsFrom(null, false));
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [paste, setPaste] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog opens for a (different) secret.
  const openedFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!open) { openedFor.current = undefined; return; }
    const target = secret?.id ?? (provider ? `provider:${provider.id}` : null);
    if (openedFor.current === target) return;
    openedFor.current = target;
    setName(secret?.name ?? '');
    setDescription(secret?.description ?? '');
    setEnvironment(secret?.environment ?? 'test');
    setExpiresAt(secret?.expiresAt ?? null);
    setAgents(secret?.availableToAgents ?? false);
    setAudience(secret?.audience ?? [{ type: 'project' }]);
    setFields(draftsFrom(secret, !!provider));
    setConnectionId(secret?.provider?.connectionId ?? provider?.id ?? null);
    setPaste('');
    setPasteOpen(false);
    setError(null);
  }, [open, secret, provider]);

  const editing = !!secret;
  const fromProvider = editing ? secret.source === 'provider' : !!provider;
  const canEditContent = !editing || secret.access.write;
  const canGovern = !editing || secret.access.write || secret.access.manage;

  const options = useQuery<AudienceOptions>({
    queryKey: ['secret-audience', projectId],
    queryFn: () => api.get<AudienceOptions>(`/projects/${projectId}/secret-audience`),
    enabled: open && canGovern,
    staleTime: 60_000,
  });

  // Provider secrets: the connections the project may use, and the names in the chosen one.
  const linkedQ = useQuery<ProviderConnection[]>({
    queryKey: ['project-secret-providers', projectId],
    queryFn: () => api.get<{ data: ProviderConnection[] }>(`/projects/${projectId}/secret-providers`).then((r) => r.data),
    enabled: open && fromProvider && canEditContent,
    staleTime: 60_000,
  });
  const connection = linkedQ.data?.find((c) => c.id === connectionId) ?? (provider?.id === connectionId ? provider : null);
  const providerName = PROVIDER_NAME[connection?.kind ?? secret?.provider?.kind ?? 'doppler'] ?? 'Doppler';
  const namesQ = useQuery<string[]>({
    queryKey: ['project-secret-provider-names', projectId, connectionId],
    queryFn: () => api.get<{ names: string[] }>(`/projects/${projectId}/secret-providers/${connectionId}/names`).then((r) => r.names),
    enabled: open && fromProvider && canEditContent && !!connection,
    staleTime: 30_000,
    retry: false,
  });

  const chooseRef = (id: string, ref: string) => {
    const f = fields.find((x) => x.id === id);
    if (!f) return;
    const guess = fieldFromRef(ref);
    const patch: Partial<FieldDraft> = { ref };
    if (!f.label.trim()) Object.assign(patch, guess);
    setField(id, patch);
    if (!editing && !name.trim()) setName(nameFromRef(ref));
  };

  const audienceKey = JSON.stringify(audience);
  const [debouncedAudience, setDebouncedAudience] = useState(audienceKey);
  useEffect(() => {
    const id = setTimeout(() => setDebouncedAudience(audienceKey), 250);
    return () => clearTimeout(id);
  }, [audienceKey]);
  const preview = useQuery<{ canReveal: { id: string; name: string; avatar: string | null }[]; canList: number }>({
    queryKey: ['secret-audience-preview', projectId, debouncedAudience],
    queryFn: () => api.post(`/projects/${projectId}/secret-audience/preview`, { audience: JSON.parse(debouncedAudience) }),
    enabled: open && canGovern && audience.length > 0,
  });

  const fieldLabels = useMemo(() => ({
    login: t('secrets.loginLabel'),
    password: t('secrets.type.password'),
    url: t('secrets.type.url'),
    apiKey: t('secrets.type.api_key'),
    note: t('secrets.type.note'),
  }), [t]);

  const applyPaste = () => {
    const proposed = pasteToFields(paste, fieldLabels);
    if (!proposed.length) { toast.error(t('secrets.pasteNothing')); return; }
    // Proposed fields replace the empty starter rows, and add to rows already filled in.
    const kept = fields.filter((f) => f.existing || f.value.trim() !== '');
    setFields(uniqueKeys([...kept, ...proposed.map((p) => ({ id: nextId(), ...p, existing: false, hasValue: false, ref: '' }))]));
    setPaste('');
    setPasteOpen(false);
    toast(t('secrets.pasteDone').replace('{n}', String(proposed.length)));
  };

  const setField = (id: string, patch: Partial<FieldDraft>) =>
    setFields((list) => list.map((f) => {
      if (f.id !== id) return f;
      const next = { ...f, ...patch };
      // A new field's key follows its label; an existing one keeps the key agents already use.
      if (!f.existing && (patch.label !== undefined || patch.type !== undefined)) next.key = fieldKeyFor(next.label, next.type);
      return next;
    }));

  const save = useMutation({
    mutationFn: async () => {
      const payloadFields = uniqueKeys(fields.filter((f) => f.label.trim())).map((f) => (fromProvider
        ? { key: f.key, label: f.label.trim(), type: f.type, ref: f.ref }
        : {
          key: f.key, label: f.label.trim(), type: f.type,
          // An existing secret field left empty keeps its stored value.
          ...(f.existing && isSecretValueType(f.type) && f.value === '' ? {} : { value: f.value }),
        }));
      if (!editing) {
        return api.post<SecretView>(`/projects/${projectId}/secrets`, {
          name: name.trim(), description: description.trim() || undefined, environment,
          expiresAt, availableToAgents: agents, audience, fields: payloadFields,
          ...(fromProvider ? { source: 'provider', connectionId } : {}),
        });
      }
      const body: Record<string, unknown> = { version: secret.version };
      if (canEditContent) Object.assign(body, { description: description.trim() || null, expiresAt, fields: payloadFields });
      if (canEditContent && fromProvider && connectionId && connectionId !== secret.provider?.connectionId) body.connectionId = connectionId;
      if (canGovern) Object.assign(body, { environment, availableToAgents: agents, audience });
      return api.patch<SecretView>(`/project-secrets/${secret.id}`, body);
    },
    onSuccess: (saved) => { toast(t('secrets.saved')); onSaved(saved); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('secrets.saveFailed')),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!audience.length) { setError(t('secrets.audienceEmpty')); return; }
    if (fromProvider && fields.some((f) => f.label.trim() && !f.ref)) {
      setError(t('secrets.providerRef').replace('{provider}', providerName) + ': ' + t('secrets.providerRefPick'));
      return;
    }
    save.mutate();
  };

  const agentsLocked = environment === 'production' && !canManage && !(editing && secret.availableToAgents && secret.environment === 'production');
  useEffect(() => {
    // Moving to production switches agent use off, as the server does.
    if (environment === 'production' && !canManage && (!editing || secret.environment !== 'production')) setAgents(false);
  }, [environment, canManage, editing, secret]);

  const hasProject = audience.some((p) => p.type === 'project');
  const people = audience.filter((p): p is { type: 'user'; id: string } => p.type === 'user');
  const depts = audience.filter((p): p is { type: 'department'; id: string } => p.type === 'department');
  const personName = (id: string) => options.data?.people.find((p) => p.id === id)?.name ?? (id === me.user.id ? me.user.name : '…');
  const deptName = (id: string) => options.data?.departments.find((d) => d.id === id)?.name ?? '…';
  const removePrincipal = (p: AudiencePrincipal) => setAudience((a) => a.filter((x) => JSON.stringify(x) !== JSON.stringify(p)));
  const addPrincipal = (p: AudiencePrincipal) => setAudience((a) => (a.some((x) => JSON.stringify(x) === JSON.stringify(p)) ? a : [...a, p]));

  // What agent runs will call it: the one variable, or the per-field pattern.
  const filledFields = fields.filter((f) => f.label.trim());
  // Several fields: the first variable in full, the rest by their suffix.
  const envVar = name.trim()
    ? filledFields.length > 1
      ? [`SECRET_${name.trim()}__${filledFields[0]!.key.toUpperCase()}`, ...filledFields.slice(1, 4).map((f) => `__${f.key.toUpperCase()}`)]
        .join(', ') + (filledFields.length > 4 ? ', …' : '')
      : `SECRET_${name.trim()}`
    : null;

  const sectionLabel = 'block text-xs font-medium text-muted-foreground';

  /** One field: label, type and – depending on the source – a value or a provider name. */
  const fieldRow = (f: FieldDraft, control: ReactNode) => (
    <div
      key={f.id}
      className="grid grid-cols-[minmax(0,1fr)_116px_28px] items-center gap-1.5 sm:grid-cols-[minmax(0,0.85fr)_116px_minmax(0,1.3fr)_28px]"
    >
      <Input value={f.label} placeholder={t(`secrets.labelPh.${f.type}`)} aria-label={t('secrets.fieldLabel')} onChange={(e) => setField(f.id, { label: e.target.value })} />
      <Select value={f.type} aria-label={t('secrets.fieldType')} onChange={(e) => setField(f.id, { type: e.target.value as SecretFieldType })} className="w-full">
        {SECRET_FIELD_TYPES.map((type) => <option key={type} value={type}>{t(`secrets.type.${type}`)}</option>)}
      </Select>
      <div className="order-last col-span-3 min-w-0 sm:order-none sm:col-span-1">{control}</div>
      <IconButton size="sm" aria-label={t('common.delete')} onClick={() => setFields((list) => list.filter((x) => x.id !== f.id))}>
        <X size={14} />
      </IconButton>
    </div>
  );

  const addFieldButton = (type: SecretFieldType) => (
    <Button
      type="button" size="xs" variant="ghost" className="-ml-1.5 text-muted-foreground"
      onClick={() => setFields((list) => [...list, { id: nextId(), key: 'field', label: '', type, value: '', existing: false, hasValue: false, ref: '' }])}
    >
      <Plus size={13} /> {t('secrets.addField')}
    </Button>
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? t('secrets.edit') : fromProvider ? t('secrets.addFromProvider').replace('{provider}', providerName) : t('secrets.add')}
      width={600}
    >
      <form onSubmit={submit} className="flex max-h-[min(82vh,820px)] flex-col">
        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pb-5 pt-4">
          {/* Identity: name, environment, description */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className={sectionLabel} htmlFor="secret-name">{t('secrets.name')}</label>
              <Input
                id="secret-name"
                autoFocus={!editing}
                disabled={editing}
                value={name}
                placeholder="ACME_ADMIN"
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
                className="font-mono placeholder:font-sans"
              />
              <p className="text-[11px] leading-4 text-faint">
                {envVar
                  ? <>{t('secrets.envVarHint')} <code className="break-all font-mono text-muted-foreground">{envVar}</code></>
                  : t('secrets.nameHint')}
              </p>
            </div>

            <div className="space-y-1.5">
              <span className={sectionLabel}>{t('secrets.environment')}</span>
              <SegmentedControl
                className="w-full"
                value={environment}
                onChange={(v) => canGovern && setEnvironment(v)}
                options={SECRET_ENVIRONMENTS.map((env) => ({
                  key: env,
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', ENV_DOT[env])} />
                      {t(`secrets.env.${env}`)}
                    </span>
                  ),
                  title: t(`secrets.env.${env}`),
                }))}
              />
            </div>

            <div className="space-y-1.5">
              <label className={sectionLabel} htmlFor="secret-desc">
                {t('secrets.description')} <span className="font-normal text-faint">· {t('secrets.optional')}</span>
              </label>
              <Input id="secret-desc" value={description} disabled={!canEditContent} placeholder={t('secrets.descriptionPh')} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>

          {/* Fields */}
          {canEditContent && (
            <section className="space-y-2">
              <div className="flex min-h-6 items-center justify-between gap-2">
                <span className={sectionLabel}>{t('secrets.fields')}</span>
                {!fromProvider && !pasteOpen && (
                  <Button type="button" size="xs" variant="ghost" className="-mr-1.5 text-muted-foreground" onClick={() => setPasteOpen(true)}>
                    <ClipboardPaste size={13} /> {t('secrets.pasteOpen')}
                  </Button>
                )}
              </div>

              {fromProvider && (
                <>
                  <p className="text-xs leading-5 text-muted-foreground">{t('secrets.providerIntro').replaceAll('{provider}', providerName)}</p>
                  {(editing ? secret.provider?.state === 'disconnected' || (linkedQ.data?.length ?? 0) > 1 : (linkedQ.data?.length ?? 0) > 1) && (
                    <SearchSelect
                      className="w-full"
                      value={connectionId}
                      placeholder={t('secrets.providerRelink')}
                      menuLabel={t('secrets.providerConnection')}
                      options={(linkedQ.data ?? []).map((c) => ({ value: c.id, label: c.label }))}
                      onChange={(v) => setConnectionId(v)}
                    />
                  )}
                  {namesQ.isError && (
                    <p className="text-xs text-destructive">
                      {namesQ.error instanceof ApiError ? namesQ.error.message : t('secrets.providerNamesFailed').replace('{provider}', providerName)}
                    </p>
                  )}
                </>
              )}

              {!fromProvider && pasteOpen && (
                <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-2.5">
                  <p className="text-xs text-muted-foreground">{t('secrets.pasteIntro')}</p>
                  <Textarea
                    autoFocus
                    rows={4}
                    value={paste}
                    placeholder={t('secrets.pastePh')}
                    aria-label={t('secrets.paste')}
                    onChange={(e) => setPaste(e.target.value)}
                    className="resize-none bg-card font-mono text-xs placeholder:font-mono"
                  />
                  <div className="flex justify-end gap-1.5">
                    <Button type="button" size="xs" variant="ghost" onClick={() => { setPaste(''); setPasteOpen(false); }}>{t('common.cancel')}</Button>
                    <Button type="button" size="xs" disabled={!paste.trim()} onClick={applyPaste}>
                      {t('secrets.pasteApply')}
                    </Button>
                  </div>
                </div>
              )}

              <div className="space-y-3 sm:space-y-1.5">
                {fields.map((f) => fieldRow(f, fromProvider ? (
                  <SearchSelect
                    className="w-full"
                    triggerClassName="font-mono"
                    width={260}
                    value={f.ref || null}
                    placeholder={namesQ.isLoading ? '…' : t('secrets.providerRefPick').replace('{provider}', providerName)}
                    disabled={!connection}
                    menuLabel={t('secrets.providerRef').replace('{provider}', providerName)}
                    options={[...new Set([...(namesQ.data ?? []), ...(f.ref ? [f.ref] : [])])].map((n) => ({
                      value: n, label: n,
                      disabled: n !== f.ref && fields.some((x) => x.id !== f.id && x.ref === n),
                    }))}
                    onChange={(v) => chooseRef(f.id, v)}
                  />
                ) : (
                  <Input
                    value={f.value}
                    type={isSecretValueType(f.type) && f.type !== 'note' ? 'password' : 'text'}
                    autoComplete="new-password"
                    placeholder={f.existing && isSecretValueType(f.type) && f.hasValue ? t('secrets.keepValue') : t(`secrets.valuePh.${f.type}`)}
                    aria-label={t('secrets.fieldValue')}
                    onChange={(e) => setField(f.id, { value: e.target.value })}
                    className={cn(isSecretValueType(f.type) && 'font-mono placeholder:font-sans')}
                  />
                )))}
                {!fields.length && <p className="py-1 text-xs text-faint">{t('secrets.noFields')}</p>}
              </div>
              {addFieldButton(fromProvider ? 'api_key' : 'password')}
            </section>
          )}

          {/* Audience */}
          {canGovern && (
            <section className="space-y-2">
              <span className={sectionLabel}>{t('secrets.audience')}</span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={hasProject}
                  onClick={() => (hasProject ? removePrincipal({ type: 'project' }) : addPrincipal({ type: 'project' }))}
                  className={cn(
                    'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[13px] transition-colors duration-150',
                    hasProject ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-dashed border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  <Users size={13} /> {t('secrets.audienceProject')}
                </button>
                {people.map((p) => (
                  <span key={p.id} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card pl-1.5 pr-0.5 text-[13px]">
                    <Avatar name={personName(p.id)} size={16} /> {personName(p.id)}
                    <IconButton size="sm" aria-label={t('common.delete')} onClick={() => removePrincipal(p)}><X size={12} /></IconButton>
                  </span>
                ))}
                {depts.map((d) => (
                  <span key={d.id} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card pl-2 pr-0.5 text-[13px]">
                    <Building2 size={13} className="text-muted-foreground" /> {deptName(d.id)}
                    <IconButton size="sm" aria-label={t('common.delete')} onClick={() => removePrincipal(d)}><X size={12} /></IconButton>
                  </span>
                ))}
                <DropdownMenu
                  width={260}
                  trigger={<Button type="button" size="xs" variant="ghost" className="text-muted-foreground"><Plus size={13} /> {t('secrets.audienceAdd')}</Button>}
                >
                  {(options.data?.people ?? []).filter((p) => !people.some((x) => x.id === p.id)).length > 0 && (
                    <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-faint">{t('secrets.audiencePeople')}</div>
                  )}
                  {(options.data?.people ?? []).filter((p) => !people.some((x) => x.id === p.id)).map((p) => (
                    <MenuItem key={p.id} icon={<Avatar name={p.name} src={p.avatar} size={16} />} onSelect={() => addPrincipal({ type: 'user', id: p.id })}>{p.name}</MenuItem>
                  ))}
                  {(options.data?.departments ?? []).filter((d) => !depts.some((x) => x.id === d.id)).length > 0 && (
                    <div className="px-2 pb-1 pt-2 text-[11px] font-medium text-faint">{t('secrets.audienceDepartments')}</div>
                  )}
                  {(options.data?.departments ?? []).filter((d) => !depts.some((x) => x.id === d.id)).map((d) => (
                    <MenuItem key={d.id} icon={<Building2 size={14} />} onSelect={() => addPrincipal({ type: 'department', id: d.id })}>{d.name}</MenuItem>
                  ))}
                </DropdownMenu>
              </div>
              <p className="flex min-h-4 items-start gap-1.5 text-xs leading-4 text-muted-foreground">
                {!audience.length ? <span className="text-destructive">{t('secrets.audienceEmpty')}</span> : preview.data ? (
                  preview.data.canReveal.length ? (
                    <span>
                      <span className="text-foreground">{t('secrets.previewCount').replace('{n}', String(preview.data.canReveal.length))}</span>
                      {' – '}{preview.data.canReveal.map((p) => p.name).join(', ')}
                      <span className="text-faint">. {t('secrets.previewNote')}</span>
                    </span>
                  ) : <span className="text-destructive">{t('secrets.previewNone')}</span>
                ) : <Spinner />}
              </p>
            </section>
          )}

          {/* Expiry and agents, as settings rows */}
          <div className="divide-y divide-border rounded-lg border border-border">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-[13px]">{t('secrets.expires')}</div>
                <p className="mt-0.5 text-[11px] leading-4 text-faint">{t('secrets.expiresHint')}</p>
              </div>
              <div className="w-44 shrink-0">
                <DateField value={expiresAt} onChange={setExpiresAt} disabled={!canEditContent} aria-label={t('secrets.expires')} />
              </div>
            </div>
            {canGovern && (
              <label className="flex cursor-pointer items-start justify-between gap-4 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-[13px]">{t('secrets.agents')}</div>
                  <p className="mt-0.5 text-[11px] leading-4 text-faint">{agentsLocked ? t('secrets.agentsProduction') : t('secrets.agentsHint')}</p>
                </div>
                <span className="pt-0.5"><Switch checked={agents} disabled={agentsLocked} onChange={setAgents} label={t('secrets.agents')} /></span>
              </label>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-border px-4 py-3">
          <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">{error}</p>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={save.isPending || (!editing && !name.trim())}>
            {save.isPending ? <Spinner /> : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
