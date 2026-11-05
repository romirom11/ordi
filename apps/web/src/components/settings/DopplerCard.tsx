/**
 * Settings → Integrations → Doppler (plan 2026-11-05-001, U5): connect a
 * read-only service token, choose the projects that may add secrets from
 * it, check it, replace it or remove it. The token is write-only: once
 * saved, nothing shows it again.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT, extendDict } from '../../lib/i18n';
import { Button, IconButton, Input, Spinner, cn, fmtRelative } from '../ui';
import { ConfirmDialog, toast } from '../overlays';
import { SearchSelect } from '../SearchSelect';
import { Disclosure, Field, RowList, StatusChip } from './primitives';
import type { ProviderConnection } from '../project/secretsShared';

extendDict({
  en: {
    'doppler.title': 'Doppler',
    'doppler.desc': 'Use secrets kept in Doppler in projects, without copying their values into ordi.',
    'doppler.intro': 'Connect a Doppler config with a service token. People on the projects you link can then add its secrets by name; the values stay in Doppler and are fetched each time someone opens one or an agent run starts.',
    'doppler.token': 'Service token',
    'doppler.project': 'Project',
    'doppler.config': 'Config',
    'doppler.targetHint': 'Optional: read from the token when left empty.',
    'doppler.label': 'Name in ordi',
    'doppler.labelHint': 'Optional, e.g. “Acme dev”.',
    'doppler.connect': 'Connect Doppler',
    'doppler.connected': 'Doppler connected',
    'doppler.howTo': 'Where do I get a service token?',
    'doppler.how1': 'In Doppler, open the project and the config (for example dev).',
    'doppler.how2': 'Access → Generate service token. Read access is enough: ordi never writes to Doppler.',
    'doppler.how3': 'A service token reaches one config only. To use another config, connect it as a second connection.',
    'doppler.projects': 'Projects that can use it',
    'doppler.noProjects': 'No project yet – link one so its people can add these secrets.',
    'doppler.linkProject': 'Link a project',
    'doppler.secretCount': '{n} secrets',
    'doppler.checked': 'checked {when}',
    'doppler.check': 'Check the connection',
    'doppler.checkOk': 'Doppler answers',
    'doppler.replaceToken': 'Replace the token',
    'doppler.replace': 'Replace',
    'doppler.replaced': 'Token replaced',
    'doppler.addAnother': 'Connect another config',
    'doppler.remove': 'Remove connection',
    'doppler.removeBody': 'Remove {label}? Its {n} secrets stay in their projects with their names and fields, marked disconnected; their values cannot be opened until they are linked to another connection.',
    'doppler.removed': 'Connection removed',
    'doppler.stateOk': 'Connected',
    'doppler.stateError': 'Error',
  },
  uk: {
    'doppler.title': 'Doppler',
    'doppler.desc': 'Використовуйте секрети з Doppler у проєктах, не копіюючи їхні значення в ordi.',
    'doppler.intro': 'Підключіть конфіг Doppler сервісним токеном. Люди в проєктах, які ви прив’яжете, зможуть додавати його секрети за назвою; значення лишаються в Doppler і запитуються щоразу, коли хтось їх відкриває або стартує запуск агента.',
    'doppler.token': 'Сервісний токен',
    'doppler.project': 'Проєкт',
    'doppler.config': 'Конфіг',
    'doppler.targetHint': 'Необов’язково: якщо порожньо, береться з токена.',
    'doppler.label': 'Назва в ordi',
    'doppler.labelHint': 'Необов’язково, напр. «Acme dev».',
    'doppler.connect': 'Підключити Doppler',
    'doppler.connected': 'Doppler підключено',
    'doppler.howTo': 'Де взяти сервісний токен?',
    'doppler.how1': 'У Doppler відкрийте проєкт і конфіг (наприклад, dev).',
    'doppler.how2': 'Access → Generate service token. Достатньо доступу на читання: ordi ніколи не пише в Doppler.',
    'doppler.how3': 'Сервісний токен відкриває лише один конфіг. Для іншого конфігу додайте ще одне підключення.',
    'doppler.projects': 'Проєкти, яким доступне',
    'doppler.noProjects': 'Ще жодного проєкту – прив’яжіть, щоб його люди могли додавати ці секрети.',
    'doppler.linkProject': 'Прив’язати проєкт',
    'doppler.secretCount': 'Секретів: {n}',
    'doppler.checked': 'перевірено {when}',
    'doppler.check': 'Перевірити підключення',
    'doppler.checkOk': 'Doppler відповідає',
    'doppler.replaceToken': 'Замінити токен',
    'doppler.replace': 'Замінити',
    'doppler.replaced': 'Токен замінено',
    'doppler.addAnother': 'Підключити ще один конфіг',
    'doppler.remove': 'Видалити підключення',
    'doppler.removeBody': 'Видалити {label}? Його секрети ({n}) лишаться в проєктах із назвами й полями, позначені як відключені; їхні значення не відкриються, доки їх не прив’яжуть до іншого підключення.',
    'doppler.removed': 'Підключення видалено',
    'doppler.stateOk': 'Підключено',
    'doppler.stateError': 'Помилка',
  },
});

interface ProjectLite { id: string; name: string; key?: string | null }

export function useDopplerConnections(enabled = true) {
  return useQuery<ProviderConnection[]>({
    queryKey: ['secret-providers'],
    queryFn: () => api.get<{ data: ProviderConnection[] }>('/secret-providers').then((r) => r.data),
    enabled,
  });
}

function ConnectForm({ onDone }: { onDone?: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ token: '', project: '', config: '', label: '' });
  const connect = useMutation({
    mutationFn: () => api.post<ProviderConnection>('/secret-providers', {
      kind: 'doppler', token: form.token.trim(),
      project: form.project.trim() || undefined, config: form.config.trim() || undefined, label: form.label.trim() || undefined,
    }),
    onSuccess: () => {
      setForm({ token: '', project: '', config: '', label: '' });
      qc.invalidateQueries({ queryKey: ['secret-providers'] });
      qc.invalidateQueries({ queryKey: ['project-secret-providers'] });
      toast(t('doppler.connected'));
      onDone?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });
  const canSubmit = form.token.trim().length >= 8 && !connect.isPending;
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <p className="text-xs text-muted-foreground">{t('doppler.intro')}</p>
      <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (canSubmit) connect.mutate(); }}>
        <Field label={t('doppler.token')} className="sm:col-span-2">
          <Input type="password" value={form.token} onChange={set('token')} placeholder="dp.st.dev.…" autoComplete="off" className="font-mono" />
        </Field>
        <Field label={t('doppler.project')}>
          <Input value={form.project} onChange={set('project')} placeholder="acme" />
        </Field>
        <Field label={t('doppler.config')}>
          <Input value={form.config} onChange={set('config')} placeholder="dev" />
        </Field>
        <p className="-mt-2 text-[11px] text-faint sm:col-span-2">{t('doppler.targetHint')}</p>
        <Field label={t('doppler.label')} className="sm:col-span-2">
          <Input value={form.label} onChange={set('label')} placeholder={t('doppler.labelHint')} />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" size="sm" disabled={!canSubmit}>
            {connect.isPending ? <Spinner /> : <KeyRound size={14} />} {t('doppler.connect')}
          </Button>
        </div>
      </form>
      <Disclosure label={t('doppler.howTo')} className="mt-3">
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
          <li>{t('doppler.how1')}</li>
          <li>{t('doppler.how2')}</li>
          <li>{t('doppler.how3')}</li>
        </ol>
      </Disclosure>
    </div>
  );
}

function ConnectionRow({ conn, projects }: { conn: ProviderConnection; projects: ProjectLite[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [token, setToken] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['secret-providers'] });
    qc.invalidateQueries({ queryKey: ['project-secret-providers'] });
  };
  const fail = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed'));

  const check = useMutation({
    mutationFn: () => api.post<ProviderConnection>(`/secret-providers/${conn.id}/check`, {}),
    onSuccess: (c) => { refresh(); if (c.status === 'ok') toast(t('doppler.checkOk')); else toast.error(c.lastError ?? t('doppler.stateError')); },
    onError: fail,
  });
  const replace = useMutation({
    mutationFn: () => api.patch<ProviderConnection>(`/secret-providers/${conn.id}`, { token: token.trim() }),
    onSuccess: () => { setToken(''); refresh(); toast(t('doppler.replaced')); },
    onError: fail,
  });
  const link = useMutation({
    mutationFn: (projectIds: string[]) => api.put<ProviderConnection>(`/secret-providers/${conn.id}/projects`, { projectIds }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/secret-providers/${conn.id}`),
    onSuccess: () => { setConfirmRemove(false); refresh(); toast(t('doppler.removed')); },
    onError: (e) => { setConfirmRemove(false); fail(e); },
  });

  const linked = conn.projectIds ?? [];
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '…';

  return (
    <div className="border-b border-border px-3 py-3 last:border-0">
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground"><KeyRound size={15} /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{conn.label}</div>
          <div className="truncate text-[11px] text-faint">
            {!conn.label.includes(`${conn.project}/${conn.config}`) && <><span className="font-mono">{conn.project}/{conn.config}</span>{' · '}</>}
            {t('doppler.secretCount').replace('{n}', String(conn.secretCount ?? 0))}
            {conn.checkedAt && <> · {t('doppler.checked').replace('{when}', fmtRelative(conn.checkedAt))}</>}
          </div>
        </div>
        <StatusChip tone={conn.status === 'ok' ? 'ok' : 'off'}>{conn.status === 'ok' ? t('doppler.stateOk') : t('doppler.stateError')}</StatusChip>
        <IconButton size="sm" onClick={() => check.mutate()} disabled={check.isPending} title={t('doppler.check')} aria-label={t('doppler.check')}>
          {check.isPending ? <Spinner /> : <RefreshCw size={14} />}
        </IconButton>
        <IconButton size="sm" onClick={() => setConfirmRemove(true)} title={t('doppler.remove')} aria-label={t('doppler.remove')}>
          <Trash2 size={14} />
        </IconButton>
      </div>
      {conn.status === 'error' && conn.lastError && <p className="mt-1.5 pl-7 text-xs text-destructive">{conn.lastError}</p>}

      <div className="mt-2.5 pl-7">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('doppler.projects')}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          {!linked.length && <span className="text-xs text-muted-foreground">{t('doppler.noProjects')}</span>}
          {linked.map((id) => (
            <span key={id} className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card pl-2 pr-1 text-[13px]">
              {projectName(id)}
              <IconButton size="sm" aria-label={t('common.delete')} disabled={link.isPending} onClick={() => link.mutate(linked.filter((x) => x !== id))}>
                <X size={12} />
              </IconButton>
            </span>
          ))}
          <SearchSelect
            value={null}
            width={240}
            options={projects.filter((p) => !linked.includes(p.id)).map((p) => ({ value: p.id, label: p.name, hint: p.key ?? undefined }))}
            onChange={(id) => link.mutate([...linked, id])}
            trigger={<Button type="button" size="xs" variant="ghost" disabled={link.isPending}><Plus size={13} /> {t('doppler.linkProject')}</Button>}
          />
        </div>
      </div>

      <Disclosure label={t('doppler.replaceToken')} className="mt-2.5 pl-7">
        <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (token.trim().length >= 8) replace.mutate(); }}>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="dp.st.…" autoComplete="off" className="font-mono" />
          <Button type="submit" size="sm" variant="outline" disabled={token.trim().length < 8 || replace.isPending}>
            {replace.isPending ? <Spinner /> : t('doppler.replace')}
          </Button>
        </form>
      </Disclosure>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate()}
        title={t('doppler.remove')}
        body={t('doppler.removeBody').replace('{label}', conn.label).replace('{n}', String(conn.secretCount ?? 0))}
        confirmLabel={t('common.delete')}
        danger
        pending={remove.isPending}
      />
    </div>
  );
}

export function DopplerCard() {
  const t = useT();
  const connections = useDopplerConnections();
  const projects = useQuery<ProjectLite[]>({
    queryKey: ['projects-lite'],
    queryFn: () => api.get<{ data: ProjectLite[] }>('/projects').then((r) => r.data.map((p) => ({ id: p.id, name: p.name, key: p.key }))),
  });
  const [adding, setAdding] = useState(false);
  const conns = connections.data ?? [];

  if (connections.isLoading) return <Spinner />;
  return (
    <div>
      {conns.length > 0 && (
        <RowList>
          {conns.map((c) => <ConnectionRow key={c.id} conn={c} projects={projects.data ?? []} />)}
        </RowList>
      )}
      {conns.length === 0 || adding ? (
        <div className={cn(conns.length > 0 && 'mt-4 border-t border-border pt-4')}>
          <ConnectForm onDone={() => setAdding(false)} />
        </div>
      ) : (
        <Button className="mt-3" size="sm" variant="ghost" onClick={() => setAdding(true)}>
          <Plus size={14} /> {t('doppler.addAnother')}
        </Button>
      )}
    </div>
  );
}
