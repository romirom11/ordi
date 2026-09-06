/**
 * Settings → Connectors (plan 2026-09-05-001, R19-R21, R38, R39, R42).
 *
 * The workspace MCP library: which external servers agents may call, who
 * authorized them, and what tools each one exposes. Needs
 * `integrations.manage`; the agent side of the checklist lives in AgentsPanel.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MCP_LIBRARY, MCP_CONNECTOR_AUTH_MODES, type McpLibraryEntry } from '@ordi/shared';
import {
  Cable, ExternalLink, MoreHorizontal, Plug2, Plus, RotateCcw, ShieldCheck, Trash2, Wrench, X,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { useMcpConnectors, useUsersLookup, type McpConnectorLookup } from '../../lib/queries';
import {
  Badge, Button, Card, Input, SegmentedControl, Select, Skeleton, Spinner, EmptyState, cn, fmtDate, fmtRelative,
} from '../ui';
import { Dialog, ConfirmDialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { SectionHead, Field, Disclosure, StatusChip } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'connectors.desc': 'MCP servers agents may call during a run. Secrets stay in ordi – the agent never sees them.',
    'connectors.add': 'Add connector',
    'connectors.none': 'No connectors yet',
    'connectors.noneHint': 'Add one from the library or by URL, then tick it on an agent.',
    'connectors.source.library': 'library',
    'connectors.source.custom': 'custom',
    'connectors.status.active': 'Active',
    'connectors.status.needs_auth': 'Needs authorization',
    'connectors.status.disabled': 'Disabled',
    'connectors.auth.none': 'no auth',
    'connectors.auth.bearer': 'bearer token',
    'connectors.auth.headers': 'headers',
    'connectors.auth.oauth': 'OAuth',
    'connectors.tools': '{n} tools',
    'connectors.noTools': 'No tools recorded yet – run a test.',
    'connectors.authorizedBy': 'Authorized by {name} on {date}',
    'connectors.authorizedOn': 'Authorized on {date}',
    'connectors.notAuthorized': 'Not authorized yet.',
    'connectors.lastTested': 'Tested {when}',
    'connectors.neverTested': 'Never tested',
    'connectors.usedBy': 'Used by {n} agents',
    'connectors.test': 'Test',
    'connectors.testOk': 'Connector answered – {n} tools',
    'connectors.testFailed': 'The connector did not answer',
    'connectors.testNeedsAuth': 'The connector needs authorization first',
    'connectors.authorize': 'Authorize',
    'connectors.reauthorize': 'Re-authorize',
    'connectors.alreadyAuthorized': 'Already authorized',
    'connectors.revokeAuth': 'Revoke authorization',
    'connectors.authRevoked': 'Authorization revoked',
    'connectors.enable': 'Enable',
    'connectors.disable': 'Disable',
    'connectors.rotate': 'Rotate secrets',
    'connectors.rotateTitle': 'Rotate the secrets',
    'connectors.rotateHint': 'Leave a field empty to keep the value it already has.',
    'connectors.rotated': 'Secrets rotated',
    'connectors.delete': 'Delete connector',
    'connectors.deleteBody': 'Delete this connector? Agents using it lose the tools it provides.',
    'connectors.deleted': 'Connector deleted',
    'connectors.oauthConnected': 'Connector authorized',
    'connectors.oauthFailed': 'Authorization failed',
    'connectors.saveFailed': 'Could not save the connector',
    'connectors.created': 'Connector added',
    // Add dialog
    'connectors.fromLibrary': 'From the library',
    'connectors.byUrl': 'By URL',
    'connectors.pick': 'Pick a server, then fill in what it needs.',
    'connectors.docs': 'Documentation',
    'connectors.oauthAfterAdd': 'This server signs in with OAuth – authorize it from its card after adding.',
    'connectors.noSecrets': 'This server needs no secrets.',
    'connectors.required': 'required',
    'connectors.optional': 'optional',
    'connectors.name': 'Name',
    'connectors.transport': 'Transport',
    'connectors.url': 'URL',
    'connectors.authMode': 'Authentication',
    'connectors.bearer': 'Token',
    'connectors.headers': 'Headers',
    'connectors.headerName': 'Header',
    'connectors.headerValue': 'Value',
    'connectors.addHeader': 'Add header',
    'connectors.oauthClientId': 'Client ID (optional)',
    'connectors.oauthClientSecret': 'Client secret (optional)',
    'connectors.oauthClientHint': 'Only needed when the provider does not support dynamic client registration.',
    'connectors.callbackUrl': 'Register this redirect URI with the provider:',
    'connectors.back': 'Back to the library',
  },
  uk: {
    'connectors.desc': 'MCP-сервери, до яких агенти можуть звертатися під час роботи. Секрети лишаються в ordi – агент їх не бачить.',
    'connectors.add': 'Додати конектор',
    'connectors.none': 'Конекторів ще немає',
    'connectors.noneHint': 'Додайте конектор із бібліотеки або за URL, а потім позначте його в агента.',
    'connectors.source.library': 'бібліотека',
    'connectors.source.custom': 'власний',
    'connectors.status.active': 'Активний',
    'connectors.status.needs_auth': 'Потрібна авторизація',
    'connectors.status.disabled': 'Вимкнений',
    'connectors.auth.none': 'без автентифікації',
    'connectors.auth.bearer': 'bearer-токен',
    'connectors.auth.headers': 'заголовки',
    'connectors.auth.oauth': 'OAuth',
    'connectors.tools': 'інструментів: {n}',
    'connectors.noTools': 'Інструменти ще не зчитані – запустіть перевірку.',
    'connectors.authorizedBy': 'Авторизував(ла) {name}, {date}',
    'connectors.authorizedOn': 'Авторизовано {date}',
    'connectors.notAuthorized': 'Ще не авторизовано.',
    'connectors.lastTested': 'Перевірено {when}',
    'connectors.neverTested': 'Ще не перевірявся',
    'connectors.usedBy': 'Використовують агентів: {n}',
    'connectors.test': 'Перевірити',
    'connectors.testOk': 'Конектор відповів – інструментів: {n}',
    'connectors.testFailed': 'Конектор не відповів',
    'connectors.testNeedsAuth': 'Спершу авторизуйте конектор',
    'connectors.authorize': 'Авторизувати',
    'connectors.reauthorize': 'Авторизувати знову',
    'connectors.alreadyAuthorized': 'Вже авторизовано',
    'connectors.revokeAuth': 'Скасувати авторизацію',
    'connectors.authRevoked': 'Авторизацію скасовано',
    'connectors.enable': 'Увімкнути',
    'connectors.disable': 'Вимкнути',
    'connectors.rotate': 'Замінити секрети',
    'connectors.rotateTitle': 'Заміна секретів',
    'connectors.rotateHint': 'Залиште поле порожнім, щоб зберегти теперішнє значення.',
    'connectors.rotated': 'Секрети замінено',
    'connectors.delete': 'Видалити конектор',
    'connectors.deleteBody': 'Видалити цей конектор? Агенти втратять інструменти, які він дає.',
    'connectors.deleted': 'Конектор видалено',
    'connectors.oauthConnected': 'Конектор авторизовано',
    'connectors.oauthFailed': 'Не вдалося авторизувати',
    'connectors.saveFailed': 'Не вдалося зберегти конектор',
    'connectors.created': 'Конектор додано',
    // Add dialog
    'connectors.fromLibrary': 'З бібліотеки',
    'connectors.byUrl': 'За URL',
    'connectors.pick': 'Оберіть сервер і заповніть те, що він потребує.',
    'connectors.docs': 'Документація',
    'connectors.oauthAfterAdd': 'Цей сервер входить через OAuth – авторизуйте його на картці після додавання.',
    'connectors.noSecrets': 'Цьому серверу не потрібні секрети.',
    'connectors.required': 'обовʼязково',
    'connectors.optional': 'необовʼязково',
    'connectors.name': 'Назва',
    'connectors.transport': 'Транспорт',
    'connectors.url': 'URL',
    'connectors.authMode': 'Автентифікація',
    'connectors.bearer': 'Токен',
    'connectors.headers': 'Заголовки',
    'connectors.headerName': 'Заголовок',
    'connectors.headerValue': 'Значення',
    'connectors.addHeader': 'Додати заголовок',
    'connectors.oauthClientId': 'Client ID (необовʼязково)',
    'connectors.oauthClientSecret': 'Client secret (необовʼязково)',
    'connectors.oauthClientHint': 'Потрібно лише тоді, коли провайдер не підтримує динамічну реєстрацію клієнта.',
    'connectors.callbackUrl': 'Зареєструйте цей redirect URI у провайдера:',
    'connectors.back': 'Назад до бібліотеки',
  },
});

interface OverviewResponse {
  runtimes: { key: string; available: boolean; installed: boolean }[];
  workers: unknown[];
  workerEnabled: boolean;
  connectorCallbackUrl: string;
}

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), template);
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/* ────────────────────────────── One connector ────────────────────────────── */

function ConnectorCard({ conn, users }: { conn: McpConnectorLookup; users: { id: string; name: string }[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['mcp-connectors'] });
    qc.invalidateQueries({ queryKey: ['agents'] });
  };

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; needsAuth?: boolean; tools?: { name: string }[]; error?: string | null }>(`/mcp-connectors/${conn.id}/test`, {}),
    onSuccess: (res) => {
      invalidate();
      if (res.ok) toast(fill(t('connectors.testOk'), { n: res.tools?.length ?? 0 }));
      else if (res.needsAuth) toast.error(t('connectors.testNeedsAuth'));
      else toast.error(res.error ? `${t('connectors.testFailed')} – ${res.error}` : t('connectors.testFailed'));
    },
    onError: (e) => toast.error(errMessage(e, t('connectors.testFailed'))),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/mcp-connectors/${conn.id}`, { ...body, version: conn.version }),
    onSuccess: () => { invalidate(); toast(t('common.saved')); },
    onError: (e) => toast.error(errMessage(e, t('connectors.saveFailed'))),
  });

  const revokeAuth = useMutation({
    mutationFn: () => api.post(`/mcp-connectors/${conn.id}/oauth/revoke`, {}),
    onSuccess: () => { invalidate(); toast(t('connectors.authRevoked')); },
    onError: (e) => toast.error(errMessage(e, t('connectors.saveFailed'))),
  });

  const del = useMutation({
    mutationFn: () => api.del(`/mcp-connectors/${conn.id}`),
    onSuccess: () => { setDeleteOpen(false); invalidate(); toast(t('connectors.deleted')); },
    onError: (e) => { setDeleteOpen(false); toast.error(errMessage(e, t('connectors.saveFailed'))); },
  });

  const authorize = async () => {
    setAuthorizing(true);
    try {
      const { authorizationUrl } = await api.post<{ authorizationUrl: string | null }>(`/mcp-connectors/${conn.id}/oauth/start`, {});
      if (!authorizationUrl) { toast(t('connectors.alreadyAuthorized')); invalidate(); setAuthorizing(false); return; }
      // Consent happens on the provider; the API redirects back to this tab.
      window.location.assign(authorizationUrl);
    } catch (e) {
      setAuthorizing(false);
      toast.error(errMessage(e, t('connectors.oauthFailed')));
    }
  };

  const who = users.find((u) => u.id === conn.oauth?.authorizedBy)?.name;
  const disabled = conn.status === 'disabled';
  const tone = conn.status === 'active' ? 'ok' : conn.status === 'needs_auth' ? 'muted' : 'off';
  const isOAuth = conn.authMode === 'oauth';

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted', disabled ? 'text-faint' : 'text-foreground')}>
          <Cable size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-[13px] font-semibold', disabled && 'text-muted-foreground')}>{conn.name}</span>
            <Badge>{t(`connectors.source.${conn.source}`, conn.source)}</Badge>
            <span className="font-mono text-[11px] text-faint">{conn.slug}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {conn.transport.toUpperCase()} · {t(`connectors.auth.${conn.authMode}`, conn.authMode)}
            {conn.url ? ` · ${conn.url}` : ''}
          </p>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {isOAuth && (
              <p>
                {conn.oauth?.authorized
                  ? who
                    ? fill(t('connectors.authorizedBy'), { name: who, date: fmtDate(conn.oauth.authorizedAt) })
                    : fill(t('connectors.authorizedOn'), { date: fmtDate(conn.oauth?.authorizedAt ?? null) })
                  : t('connectors.notAuthorized')}
              </p>
            )}
            <p>
              {conn.lastTestedAt ? fill(t('connectors.lastTested'), { when: fmtRelative(conn.lastTestedAt) }) : t('connectors.neverTested')}
              {' · '}{fill(t('connectors.usedBy'), { n: conn.agentCount })}
            </p>
            {conn.lastError && <p className="text-destructive">{conn.lastError}</p>}
          </div>
        </div>
        <StatusChip tone={tone}>{t(`connectors.status.${conn.status}`, conn.status)}</StatusChip>
        <Button size="sm" variant="outline" onClick={() => test.mutate()} disabled={test.isPending}>
          {test.isPending ? <Spinner /> : <ShieldCheck size={14} />} {t('connectors.test')}
        </Button>
        {isOAuth && (
          <Button size="sm" onClick={authorize} disabled={authorizing}>
            {authorizing ? <Spinner /> : <Plug2 size={14} />}
            {conn.oauth?.authorized ? t('connectors.reauthorize') : t('connectors.authorize')}
          </Button>
        )}
        <DropdownMenu align="end" trigger={<Button variant="ghost" size="sm" className="h-7 w-7 px-0"><MoreHorizontal size={15} /></Button>}>
          {conn.authMode !== 'none' && conn.authMode !== 'oauth' && (
            <MenuItem icon={<RotateCcw size={14} />} onSelect={() => setRotateOpen(true)}>{t('connectors.rotate')}</MenuItem>
          )}
          {isOAuth && conn.oauth?.authorized && (
            <MenuItem icon={<X size={14} />} onSelect={() => revokeAuth.mutate()}>{t('connectors.revokeAuth')}</MenuItem>
          )}
          {disabled
            ? <MenuItem icon={<RotateCcw size={14} />} onSelect={() => patch.mutate({ enabled: true })}>{t('connectors.enable')}</MenuItem>
            : <MenuItem onSelect={() => patch.mutate({ enabled: false })}>{t('connectors.disable')}</MenuItem>}
          <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setDeleteOpen(true)}>{t('connectors.delete')}</MenuItem>
        </DropdownMenu>
      </div>

      <Disclosure label={fill(t('connectors.tools'), { n: conn.toolCount })} className="mt-3 border-t border-border pt-3">
        {conn.tools.length === 0 ? (
          <p className="pt-2 text-xs text-muted-foreground">{t('connectors.noTools')}</p>
        ) : (
          <ul className="space-y-1 pt-2">
            {conn.tools.map((tool) => (
              <li key={tool.name} className="flex items-start gap-2 text-xs">
                <Wrench size={12} className="mt-0.5 shrink-0 text-faint" />
                <span className="font-mono text-[11px]">{tool.name}</span>
                {tool.description && <span className="min-w-0 flex-1 truncate text-muted-foreground">{tool.description}</span>}
              </li>
            ))}
          </ul>
        )}
      </Disclosure>

      <RotateSecretsDialog open={rotateOpen} onClose={() => setRotateOpen(false)} conn={conn} />

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => del.mutate()}
        title={t('connectors.delete')}
        body={t('connectors.deleteBody')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        danger
        pending={del.isPending}
      />
    </Card>
  );
}

/** Rotate what the connector authenticates with – library fields or raw headers. */
function RotateSecretsDialog({ open, onClose, conn }: { open: boolean; onClose: () => void; conn: McpConnectorLookup }) {
  const t = useT();
  const qc = useQueryClient();
  const entry = conn.libraryKey ? MCP_LIBRARY.find((e) => e.key === conn.libraryKey) : undefined;
  const fields = entry
    ? entry.secrets.map((f) => ({ key: f.key, label: f.label, help: f.help }))
    : conn.secretKeys.map((k) => ({ key: k, label: k, help: undefined as string | undefined }));
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => { if (open) setValues({}); }, [open]);

  const rotate = useMutation({
    mutationFn: () => {
      const filled = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== ''));
      const body: Record<string, unknown> = { version: conn.version };
      if (conn.authMode === 'bearer' && !entry) body.bearer = filled.Authorization ?? Object.values(filled)[0] ?? '';
      else if (entry) body.secrets = filled;
      else body.headers = filled;
      return api.patch(`/mcp-connectors/${conn.id}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-connectors'] });
      toast(t('connectors.rotated'));
      onClose();
    },
    onError: (e) => toast.error(errMessage(e, t('connectors.saveFailed'))),
  });

  const any = Object.values(values).some((v) => v.trim() !== '');

  return (
    <Dialog open={open} onClose={onClose} title={t('connectors.rotateTitle')} width={460}>
      <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); if (any && !rotate.isPending) rotate.mutate(); }}>
        <p className="text-xs text-muted-foreground">{t('connectors.rotateHint')}</p>
        {fields.length === 0 && <p className="text-xs text-muted-foreground">{t('connectors.noSecrets')}</p>}
        {fields.map((f) => (
          <div key={f.key}>
            <Field label={f.label}>
              <Input
                type="password"
                autoComplete="off"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </Field>
            {f.help && <p className="mt-1 text-[11px] text-faint">{f.help}</p>}
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!any || rotate.isPending}>
            {rotate.isPending ? <Spinner /> : <RotateCcw size={14} />} {t('connectors.rotate')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ────────────────────────────── Add connector ────────────────────────────── */

function LibraryForm({ entry, onBack, onDone, callbackUrl }: {
  entry: McpLibraryEntry; onBack: () => void; onDone: () => void; callbackUrl?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(entry.name);
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const create = useMutation({
    mutationFn: () => api.post('/mcp-connectors/library', {
      libraryKey: entry.key,
      name: name.trim() || entry.name,
      secrets: Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim() !== '')),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-connectors'] });
      toast(t('connectors.created'));
      onDone();
    },
    onError: (e) => toast.error(errMessage(e, t('connectors.saveFailed'))),
  });

  const missing = entry.secrets.some((f) => f.required && !(secrets[f.key] ?? '').trim());

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!missing && !create.isPending) create.mutate(); }}>
      <button type="button" onClick={onBack} className="text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground">
        ← {t('connectors.back')}
      </button>
      <div className="rounded-md border border-border bg-muted/40 p-3">
        <div className="text-[13px] font-medium">{entry.name}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{entry.description}</p>
        <a href={entry.docsUrl} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
          {t('connectors.docs')} <ExternalLink size={11} />
        </a>
      </div>

      <Field label={t('connectors.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      {entry.auth === 'oauth' ? (
        <>
          <p className="text-xs text-muted-foreground">{t('connectors.oauthAfterAdd')}</p>
          {callbackUrl && (
            <p className="text-[11px] text-faint">
              {t('connectors.callbackUrl')} <span className="font-mono">{callbackUrl}</span>
            </p>
          )}
        </>
      ) : entry.secrets.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('connectors.noSecrets')}</p>
      ) : (
        entry.secrets.map((f) => (
          <div key={f.key}>
            <Field label={(
              <span>
                {f.label}
                <span className="text-faint"> · {f.required ? t('connectors.required') : t('connectors.optional')}</span>
              </span>
            )}>
              <Input
                type="password"
                autoComplete="off"
                value={secrets[f.key] ?? ''}
                onChange={(e) => setSecrets((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            </Field>
            {f.help && <p className="mt-1 text-[11px] text-faint">{f.help}</p>}
          </div>
        ))
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="submit" size="sm" disabled={missing || create.isPending}>
          {create.isPending ? <Spinner /> : <Plus size={14} />} {t('common.add')}
        </Button>
      </div>
    </form>
  );
}

function UrlForm({ onDone, callbackUrl }: { onDone: () => void; callbackUrl?: string }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'http' | 'sse'>('http');
  const [url, setUrl] = useState('https://');
  const [authMode, setAuthMode] = useState<string>('none');
  const [bearer, setBearer] = useState('');
  const [headers, setHeaders] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  const create = useMutation({
    mutationFn: () => api.post('/mcp-connectors/custom', {
      name: name.trim(),
      transport,
      url: url.trim(),
      authMode,
      bearer: authMode === 'bearer' ? bearer.trim() : undefined,
      headers: authMode === 'headers'
        ? Object.fromEntries(headers.filter((h) => h.key.trim() && h.value.trim()).map((h) => [h.key.trim(), h.value.trim()]))
        : undefined,
      oauthClientId: authMode === 'oauth' && clientId.trim() ? clientId.trim() : undefined,
      oauthClientSecret: authMode === 'oauth' && clientSecret.trim() ? clientSecret.trim() : undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['mcp-connectors'] });
      toast(t('connectors.created'));
      onDone();
    },
    onError: (e) => toast.error(errMessage(e, t('connectors.saveFailed'))),
  });

  const valid = name.trim().length > 0
    && /^https?:\/\/.+/.test(url.trim())
    && (authMode !== 'bearer' || bearer.trim().length > 0)
    && (authMode !== 'headers' || headers.some((h) => h.key.trim() && h.value.trim()));

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (valid && !create.isPending) create.mutate(); }}>
      <Field label={t('connectors.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Internal docs" autoFocus />
      </Field>
      <div className="grid grid-cols-[120px_1fr] gap-3">
        <Field label={t('connectors.transport')}>
          <Select value={transport} onChange={(e) => setTransport(e.target.value as 'http' | 'sse')} className="w-full">
            <option value="http">HTTP</option>
            <option value="sse">SSE</option>
          </Select>
        </Field>
        <Field label={t('connectors.url')}>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
        </Field>
      </div>
      <Field label={t('connectors.authMode')}>
        <Select value={authMode} onChange={(e) => setAuthMode(e.target.value)} className="w-full">
          {MCP_CONNECTOR_AUTH_MODES.map((m) => <option key={m} value={m}>{t(`connectors.auth.${m}`)}</option>)}
        </Select>
      </Field>

      {authMode === 'bearer' && (
        <Field label={t('connectors.bearer')}>
          <Input type="password" autoComplete="off" value={bearer} onChange={(e) => setBearer(e.target.value)} />
        </Field>
      )}

      {authMode === 'headers' && (
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t('connectors.headers')}</div>
          <div className="space-y-1.5">
            {headers.map((h, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="w-40"
                  placeholder={t('connectors.headerName')}
                  value={h.key}
                  onChange={(e) => setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                />
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder={t('connectors.headerValue')}
                  value={h.value}
                  onChange={(e) => setHeaders((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                />
                {headers.length > 1 && (
                  <Button type="button" size="sm" variant="ghost" className="h-8 w-8 px-0" onClick={() => setHeaders((rows) => rows.filter((_, j) => j !== i))}>
                    <X size={14} />
                  </Button>
                )}
              </div>
            ))}
          </div>
          <Button type="button" size="xs" variant="ghost" className="mt-1.5" onClick={() => setHeaders((rows) => [...rows, { key: '', value: '' }])}>
            <Plus size={12} /> {t('connectors.addHeader')}
          </Button>
        </div>
      )}

      {authMode === 'oauth' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('connectors.oauthClientId')}>
              <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </Field>
            <Field label={t('connectors.oauthClientSecret')}>
              <Input type="password" autoComplete="off" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
            </Field>
          </div>
          <p className="text-[11px] text-faint">{t('connectors.oauthClientHint')}</p>
          {callbackUrl && (
            <p className="text-[11px] text-faint">
              {t('connectors.callbackUrl')} <span className="font-mono">{callbackUrl}</span>
            </p>
          )}
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="submit" size="sm" disabled={!valid || create.isPending}>
          {create.isPending ? <Spinner /> : <Plus size={14} />} {t('common.add')}
        </Button>
      </div>
    </form>
  );
}

function AddConnectorDialog({ open, onClose, callbackUrl }: { open: boolean; onClose: () => void; callbackUrl?: string }) {
  const t = useT();
  const [mode, setMode] = useState<'library' | 'url'>('library');
  const [picked, setPicked] = useState<McpLibraryEntry | null>(null);

  useEffect(() => { if (open) { setMode('library'); setPicked(null); } }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title={t('connectors.add')} width={560}>
      <div className="max-h-[68vh] space-y-3 overflow-y-auto p-4">
        <SegmentedControl
          className="w-full"
          value={mode}
          onChange={(m) => { setMode(m); setPicked(null); }}
          options={[
            { key: 'library' as const, label: t('connectors.fromLibrary') },
            { key: 'url' as const, label: t('connectors.byUrl') },
          ]}
        />

        {mode === 'library' ? (
          picked ? (
            <LibraryForm entry={picked} onBack={() => setPicked(null)} onDone={onClose} callbackUrl={callbackUrl} />
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('connectors.pick')}</p>
              <div className="grid grid-cols-2 gap-2">
                {MCP_LIBRARY.map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => setPicked(entry)}
                    className="rounded-lg border border-border bg-card p-3 text-left transition-colors duration-150 hover:border-border-strong"
                  >
                    <div className="flex items-center gap-2">
                      <Cable size={14} className="shrink-0 text-muted-foreground" />
                      <span className="truncate text-[13px] font-medium">{entry.name}</span>
                      {entry.auth === 'oauth' && <Badge>{t('connectors.auth.oauth')}</Badge>}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{entry.description}</p>
                    <span className="mt-1 block truncate text-[10px] uppercase tracking-wider text-faint">{entry.transport}</span>
                  </button>
                ))}
              </div>
            </>
          )
        ) : (
          <UrlForm onDone={onClose} callbackUrl={callbackUrl} />
        )}
      </div>
    </Dialog>
  );
}

/* ────────────────────────────── Panel ────────────────────────────── */

export function McpConnectorsPanel() {
  const t = useT();
  const can = useCan();
  const connectorsQ = useMcpConnectors();
  const usersQ = useUsersLookup();
  const overviewQ = useQuery({
    queryKey: ['agents-overview'],
    queryFn: () => api.get<OverviewResponse>('/agents/overview'),
    enabled: can('agents.manage'),
  });
  const [addOpen, setAddOpen] = useState(false);

  // The consent redirect lands back here with ?oauth=… – say what happened,
  // then strip the params so a reload does not repeat the toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('oauth');
    if (!outcome) return;
    const connector = params.get('connector');
    const reason = params.get('reason');
    if (outcome === 'connected') toast(connector ? `${t('connectors.oauthConnected')}: ${connector}` : t('connectors.oauthConnected'));
    else toast.error(reason ? `${t('connectors.oauthFailed')} – ${reason}` : t('connectors.oauthFailed'));
    params.delete('oauth');
    params.delete('connector');
    params.delete('reason');
    const q = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connectors = connectorsQ.data ?? [];
  const users = useMemo(() => usersQ.data ?? [], [usersQ.data]);
  const callbackUrl = overviewQ.data?.connectorCallbackUrl;

  return (
    <div>
      <SectionHead
        title={t('settings.connectors')}
        desc={t('connectors.desc')}
        actions={<Button size="sm" onClick={() => setAddOpen(true)}><Plus size={14} /> {t('connectors.add')}</Button>}
      />

      {connectorsQ.isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
      ) : connectors.length === 0 ? (
        <EmptyState
          icon={<Plug2 size={18} />}
          title={t('connectors.none')}
          hint={t('connectors.noneHint')}
          action={<Button size="sm" onClick={() => setAddOpen(true)}><Plus size={14} /> {t('connectors.add')}</Button>}
        />
      ) : (
        <div className="space-y-2">
          {connectors.map((c) => <ConnectorCard key={c.id} conn={c} users={users} />)}
        </div>
      )}

      {callbackUrl && connectors.length > 0 && (
        <p className="mt-4 truncate text-[11px] text-faint">
          {t('connectors.callbackUrl')} <span className="font-mono">{callbackUrl}</span>
        </p>
      )}

      <AddConnectorDialog open={addOpen} onClose={() => setAddOpen(false)} callbackUrl={callbackUrl} />
    </div>
  );
}
