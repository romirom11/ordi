import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, PERMISSION_META, type Permission } from '@ordi/shared';
import { api, qs } from '../lib/api';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import { Button, Input, Select, Card, Badge, PageHeader, EmptyState, Skeleton, cn } from '../components/ui';
import { Plus, Copy } from 'lucide-react';

interface NavItem { id: string; label: string; perm: string }
const NAV: NavItem[] = [
  { id: 'workspace', label: 'Workspace', perm: 'settings.manage' },
  { id: 'users', label: 'Users', perm: 'users.manage' },
  { id: 'roles', label: 'Roles', perm: 'roles.manage' },
  { id: 'custom-fields', label: 'Custom fields', perm: 'settings.manage' },
  { id: 'finance', label: 'Finance', perm: 'finance.settings' },
  { id: 'integrations', label: 'Integrations', perm: 'integrations.manage' },
  { id: 'audit', label: 'Audit log', perm: 'audit.read' },
  { id: 'events', label: 'Event queue', perm: 'audit.read' },
];

export function SettingsPage({ section }: { section?: string }) {
  const can = useCan();
  const items = NAV.filter((n) => can(n.perm));
  const requested = section ?? 'workspace';
  const active = items.find((i) => i.id === requested) ?? items[0];

  if (!active) {
    return <EmptyState title="No settings available" hint="You don't have permission to manage any workspace settings." />;
  }

  return (
    <div>
      <PageHeader title="Settings" />
      <div className="flex">
        <aside className="w-52 shrink-0 border-r border-border p-3">
          <nav className="space-y-0.5">
            {items.map((i) => (
              <Link
                key={i.id}
                to={`/settings/${i.id}`}
                className={cn('block rounded-md px-2.5 py-1.5 text-sm', i.id === active.id ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}
              >
                {i.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex-1 overflow-auto p-6">
          {active.id === 'workspace' && <WorkspacePanel />}
          {active.id === 'users' && <UsersPanel />}
          {active.id === 'roles' && <RolesPanel />}
          {active.id === 'custom-fields' && <CustomFieldsPanel />}
          {active.id === 'finance' && <FinancePanel />}
          {active.id === 'integrations' && <IntegrationsPanel />}
          {active.id === 'audit' && <AuditPanel />}
          {active.id === 'events' && <DlqPanel />}
        </div>
      </div>
    </div>
  );
}

function WorkspacePanel() {
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ['workspace'], queryFn: () => api.get<{ name?: string; currency?: string }>('/settings/workspace') });
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  useEffect(() => {
    if (ws.data) {
      setName(ws.data.name ?? '');
      setCurrency(ws.data.currency ?? 'USD');
    }
  }, [ws.data]);
  const save = useMutation({
    mutationFn: () => api.patch('/settings/workspace', { name, currency }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workspace'] }),
  });

  if (ws.isLoading) return <Skeleton className="h-40 w-full max-w-lg" />;
  return (
    <Card className="max-w-lg p-5">
      <div className="mb-4 text-sm font-medium">Workspace</div>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <label className="block text-xs text-muted-foreground">Name<Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" /></label>
        <label className="block text-xs text-muted-foreground">Default currency<Input value={currency} onChange={(e) => setCurrency(e.target.value)} className="mt-1 w-28" /></label>
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={save.isPending}>Save</Button>
          {save.isSuccess && <span className="text-xs text-muted-foreground">Saved.</span>}
        </div>
      </form>
    </Card>
  );
}

interface UserRow { id: string; name?: string | null; email?: string | null; roleId?: string | null; roleName?: string | null; isActive?: boolean }
interface Role { id: string; name: string; isSystem?: boolean; permissions?: string[]; userCount?: number }

function UsersPanel() {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ data: UserRow[] }>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: Role[] }>('/roles') });
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => api.post<{ inviteUrl?: string }>('/users/invite', { email, roleId }),
    onSuccess: (r) => {
      setInviteUrl(r?.inviteUrl ?? null);
      setEmail('');
      qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  const changeRole = useMutation({
    mutationFn: ({ id, roleId: rid }: { id: string; roleId: string }) => api.patch(`/users/${id}/role`, { roleId: rid }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
  const roleList = roles.data?.data ?? [];
  const rows = users.data?.data ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <Card className="p-5">
        <div className="mb-3 text-sm font-medium">Invite user</div>
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (email && roleId) invite.mutate(); }}>
          <label className="text-xs text-muted-foreground">Email<Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="mt-1 w-64" /></label>
          <label className="text-xs text-muted-foreground">Role
            <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="mt-1 block h-9">
              <option value="">Select role…</option>
              {roleList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </label>
          <Button type="submit" size="sm" disabled={invite.isPending || !email || !roleId}><Plus size={14} /> Invite</Button>
        </form>
        {inviteUrl && (
          <div className="mt-3 flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
            <span className="truncate font-mono text-xs">{inviteUrl}</span>
            <button className="ml-auto rounded p-1 hover:bg-muted" title="Copy" onClick={() => navigator.clipboard?.writeText(inviteUrl)}><Copy size={13} /></button>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        {users.isLoading ? (
          <div className="p-4"><Skeleton className="h-32 w-full" /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium">{u.name ?? '—'}{u.isActive === false && <span className="ml-2 text-xs text-muted-foreground">(inactive)</span>}</td>
                  <td className="px-4 py-2 text-muted-foreground">{u.email ?? '—'}</td>
                  <td className="px-4 py-2">
                    <Select value={u.roleId ?? ''} onChange={(e) => changeRole.mutate({ id: u.id, roleId: e.target.value })} className="h-8 text-xs">
                      {!u.roleId && <option value="">—</option>}
                      {roleList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function normalizeCatalog(raw: any): { domain: string; perms: { key: string; label: string }[] }[] {
  const flat: { key: string; domain: string; label: string }[] = [];
  const push = (key?: string, domain?: string, label?: string) => {
    if (!key) return;
    flat.push({ key, domain: domain ?? key.split('.')[0] ?? 'other', label: label ?? key });
  };
  const consider = (arr: any[]) => {
    for (const item of arr) {
      if (typeof item === 'string') push(item);
      else if (item && typeof item === 'object') push(item.key ?? item.permission ?? item.id, item.domain, item.label);
    }
  };
  if (Array.isArray(raw)) consider(raw);
  else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.permissions)) consider(raw.permissions);
    if (Array.isArray(raw.data)) consider(raw.data);
    if (Array.isArray(raw.domains)) {
      for (const d of raw.domains) {
        if (Array.isArray(d?.permissions)) {
          for (const p of d.permissions) push(typeof p === 'string' ? p : p?.key ?? p?.permission, d.domain ?? d.name, typeof p === 'object' ? p?.label : undefined);
        }
      }
    }
  }
  if (flat.length === 0) {
    for (const key of PERMISSIONS) {
      const meta = PERMISSION_META[key as Permission];
      push(key, meta.domain, meta.label);
    }
  }
  const byDomain = new Map<string, { key: string; label: string }[]>();
  for (const f of flat) {
    const bucket = byDomain.get(f.domain) ?? [];
    bucket.push({ key: f.key, label: f.label });
    byDomain.set(f.domain, bucket);
  }
  return Array.from(byDomain.entries()).map(([domain, perms]) => ({ domain, perms }));
}

function RolesPanel() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: Role[] }>('/roles') });
  const catalog = useQuery({ queryKey: ['rolesCatalog'], queryFn: () => api.get<any>('/roles/catalog') });
  const [newRole, setNewRole] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/roles', { name: newRole, permissions: [] }),
    onSuccess: () => { setNewRole(''); qc.invalidateQueries({ queryKey: ['roles'] }); },
  });
  const grouped = normalizeCatalog(catalog.data);
  const roleList = roles.data?.data ?? [];

  return (
    <div className="max-w-4xl space-y-6">
      <Card className="p-4">
        <form className="flex items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (newRole.trim()) create.mutate(); }}>
          <label className="text-xs text-muted-foreground">New role<Input value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder="Role name" className="mt-1 w-56" /></label>
          <Button type="submit" size="sm" disabled={create.isPending}><Plus size={14} /> Create role</Button>
        </form>
      </Card>

      {roles.isLoading && <Skeleton className="h-64 w-full" />}
      {roleList.map((role) => (
        <RoleEditor key={role.id + String(role.permissions?.length ?? 0)} role={role} grouped={grouped} />
      ))}
    </div>
  );
}

function RoleEditor({ role, grouped }: { role: Role; grouped: { domain: string; perms: { key: string; label: string }[] }[] }) {
  const qc = useQueryClient();
  const [perms, setPerms] = useState<Set<string>>(() => new Set(role.permissions ?? []));
  const disabled = !!role.isSystem;
  const save = useMutation({
    mutationFn: () => api.patch(`/roles/${role.id}`, { permissions: Array.from(perms) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['roles'] }),
  });
  const toggle = (k: string) => setPerms((prev) => {
    const n = new Set(prev);
    if (n.has(k)) n.delete(k); else n.add(k);
    return n;
  });

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{role.name}</span>
          {role.isSystem && <Badge>system</Badge>}
          {role.userCount != null && <span className="text-xs text-muted-foreground">{role.userCount} users</span>}
        </div>
        {!disabled && <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>Save</Button>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {grouped.map((g) => (
          <div key={g.domain}>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g.domain}</div>
            <div className="space-y-1">
              {g.perms.map((p) => (
                <label key={p.key} className={cn('flex items-center gap-2 text-sm', disabled && 'opacity-60')}>
                  <input type="checkbox" checked={perms.has(p.key)} disabled={disabled} onChange={() => toggle(p.key)} />
                  <span title={p.key}>{p.label}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

interface CustomField { id: string; key: string; label?: string | null; type?: string | null; required?: boolean }
const ENTITY_TYPES = ['companies', 'contacts', 'deals', 'projects', 'tasks', 'invoices', 'quotes', 'employees', 'applicants'];
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'url', 'user'];

function CustomFieldsPanel() {
  const qc = useQueryClient();
  const [entityType, setEntityType] = useState('companies');
  const fields = useQuery({ queryKey: ['customFields', entityType], queryFn: () => api.get<{ data: CustomField[] }>('/custom-fields' + qs({ entityType })) });
  const [form, setForm] = useState({ key: '', label: '', type: 'text' });
  const create = useMutation({
    mutationFn: () => api.post('/custom-fields', { entityType, key: form.key, label: form.label, type: form.type }),
    onSuccess: () => { setForm({ key: '', label: '', type: 'text' }); qc.invalidateQueries({ queryKey: ['customFields', entityType] }); },
  });
  const rows = fields.data?.data ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Entity</span>
        <Select value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>
      <Card className="p-4">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (form.key && form.label) create.mutate(); }}>
          <label className="text-xs text-muted-foreground">Key<Input value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} placeholder="budget" className="mt-1 w-40" /></label>
          <label className="text-xs text-muted-foreground">Label<Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} className="mt-1 w-48" /></label>
          <label className="text-xs text-muted-foreground">Type
            <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className="mt-1 block h-9">
              {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
          </label>
          <Button type="submit" size="sm" disabled={create.isPending}><Plus size={14} /> Add field</Button>
        </form>
      </Card>
      <Card className="overflow-hidden">
        {fields.isLoading ? (
          <div className="p-4"><Skeleton className="h-24 w-full" /></div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No custom fields on {entityType}.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Key</th>
                <th className="px-4 py-2 font-medium">Label</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Required</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-mono text-xs">{f.key}</td>
                  <td className="px-4 py-2">{f.label ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{f.type ?? '—'}</td>
                  <td className="px-4 py-2">{f.required ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

interface TaxRate { id: string; name?: string | null; ratePercent?: number | string }
function FinancePanel() {
  const taxes = useQuery({ queryKey: ['taxRates'], queryFn: () => api.get<{ data: TaxRate[] }>('/tax-rates') });
  const rows = taxes.data?.data ?? [];
  return (
    <div className="max-w-2xl space-y-4">
      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-medium">Tax rates</div>
        {taxes.isLoading ? (
          <div className="p-4"><Skeleton className="h-20 w-full" /></div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">No tax rates configured.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">{t.name ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{Number(t.ratePercent ?? 0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <p className="text-xs text-muted-foreground">Document numbering, reminder rules and email templates are configured here. Default currency is set under Workspace.</p>
    </div>
  );
}

interface GitConnection { id: string; provider?: string | null; fullName?: string | null; status?: string | null; instanceUrl?: string | null }
interface Webhook { id: string; url?: string | null; active?: boolean; eventTypes?: string[] }
function IntegrationsPanel() {
  const qc = useQueryClient();
  const connections = useQuery({ queryKey: ['gitConnections'], queryFn: () => api.get<{ data: GitConnection[] }>('/integrations/git/connections') });
  const webhooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<{ data: Webhook[] }>('/webhooks') });
  const [conn, setConn] = useState({ provider: 'github', instanceUrl: '', token: '' });
  const addConn = useMutation({
    mutationFn: () => api.post('/integrations/git/connections', { provider: conn.provider, instanceUrl: conn.instanceUrl || undefined, token: conn.token || undefined }),
    onSuccess: () => { setConn({ provider: 'github', instanceUrl: '', token: '' }); qc.invalidateQueries({ queryKey: ['gitConnections'] }); },
  });
  const [hook, setHook] = useState({ url: '', eventTypes: '' });
  const addHook = useMutation({
    mutationFn: () => api.post('/webhooks', { url: hook.url, eventTypes: hook.eventTypes.split(',').map((s) => s.trim()).filter(Boolean) }),
    onSuccess: () => { setHook({ url: '', eventTypes: '' }); qc.invalidateQueries({ queryKey: ['webhooks'] }); },
  });
  const conns = connections.data?.data ?? [];
  const hooks = webhooks.data?.data ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <Card className="p-4">
        <div className="mb-3 text-sm font-medium">Git connections</div>
        {connections.isLoading ? <Skeleton className="h-16 w-full" /> : conns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No git connections yet.</p>
        ) : (
          <div className="space-y-1">
            {conns.map((c) => (
              <div key={c.id} className="flex items-center justify-between rounded bg-muted/50 px-3 py-2 text-sm">
                <span>{c.provider ?? 'git'} · {c.fullName ?? c.instanceUrl ?? c.id}</span>
                <Badge color={c.status === 'connected' ? '#22c55e' : '#6b7280'}>{c.status ?? 'connected'}</Badge>
              </div>
            ))}
          </div>
        )}
        <form className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); addConn.mutate(); }}>
          <label className="text-xs text-muted-foreground">Provider
            <Select value={conn.provider} onChange={(e) => setConn((c) => ({ ...c, provider: e.target.value }))} className="mt-1 block h-9">
              {['github', 'gitlab', 'gitea'].map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">Instance URL<Input value={conn.instanceUrl} onChange={(e) => setConn((c) => ({ ...c, instanceUrl: e.target.value }))} placeholder="optional" className="mt-1 w-48" /></label>
          <label className="text-xs text-muted-foreground">Token<Input value={conn.token} onChange={(e) => setConn((c) => ({ ...c, token: e.target.value }))} type="password" className="mt-1 w-40" /></label>
          <Button type="submit" size="sm" disabled={addConn.isPending}><Plus size={14} /> Add</Button>
        </form>
      </Card>

      <Card className="p-4">
        <div className="mb-3 text-sm font-medium">Outgoing webhooks</div>
        {webhooks.isLoading ? <Skeleton className="h-16 w-full" /> : hooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No webhooks configured.</p>
        ) : (
          <div className="space-y-1">
            {hooks.map((h) => (
              <div key={h.id} className="flex items-center justify-between rounded bg-muted/50 px-3 py-2 text-sm">
                <span className="truncate font-mono text-xs">{h.url}</span>
                <Badge color={h.active === false ? '#6b7280' : '#22c55e'}>{h.active === false ? 'off' : 'active'}</Badge>
              </div>
            ))}
          </div>
        )}
        <form className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3" onSubmit={(e) => { e.preventDefault(); if (hook.url) addHook.mutate(); }}>
          <label className="text-xs text-muted-foreground">URL<Input value={hook.url} onChange={(e) => setHook((h) => ({ ...h, url: e.target.value }))} placeholder="https://…" className="mt-1 w-64" /></label>
          <label className="text-xs text-muted-foreground">Events<Input value={hook.eventTypes} onChange={(e) => setHook((h) => ({ ...h, eventTypes: e.target.value }))} placeholder="invoice.sent, payment.recorded" className="mt-1 w-56" /></label>
          <Button type="submit" size="sm" disabled={addHook.isPending}><Plus size={14} /> Add</Button>
        </form>
      </Card>
    </div>
  );
}

/* ── Audit log (PRD §14.4) ── */

interface AuditRow { id: string; entityType: string; entityId: string; actorId?: string | null; actorType?: string; action: string; diff?: Record<string, unknown>; sensitivity?: string; createdAt: string }

function AuditPanel() {
  const [entityType, setEntityType] = useState('');
  const { data, isLoading } = useQuery<{ data: AuditRow[] }>({
    queryKey: ['audit', entityType],
    queryFn: () => api.get<{ data: AuditRow[] }>(`/audit${qs({ entityType })}`),
  });
  const rows = data?.data ?? [];
  return (
    <div className="max-w-4xl space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">Audit log</h2>
        <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="ml-auto">
          <option value="">All entities</option>
          {['company', 'contact', 'deal', 'project', 'task', 'invoice', 'quote', 'payment', 'employee', 'leave_request', 'user', 'compensation'].map((t) => <option key={t} value={t}>{t}</option>)}
        </Select>
      </div>
      {isLoading ? <Skeleton className="h-40" /> : rows.length === 0 ? (
        <EmptyState title="No audit records" hint="Mutations across the workspace appear here with redacted diffs." />
      ) : (
        <Card className="divide-y divide-border">
          {rows.map((r) => (
            <div key={r.id} className="px-3 py-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge className="bg-muted text-muted-foreground">{r.entityType}</Badge>
                <span className="font-medium">{r.action}</span>
                {r.sensitivity === 'sensitive' && <Badge className="bg-destructive/10 text-destructive">sensitive</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">{r.actorType ?? 'user'} · {new Date(r.createdAt).toLocaleString()}</span>
              </div>
              {r.diff && Object.keys(r.diff).length > 0 && (
                <pre className="mt-1 overflow-x-auto rounded bg-muted/60 p-2 text-xs text-muted-foreground">{JSON.stringify(r.diff, null, 1)}</pre>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

/* ── Dead-letter queue admin (PRD §3.3): inspect + replay ── */

interface DlqRow { id: string; consumer: string; eventId: string; error: string; attempts: number; createdAt: string; payload?: Record<string, unknown> }

function DlqPanel() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery<{ data: DlqRow[]; counts?: Record<string, number> }>({
    queryKey: ['dlq'],
    queryFn: () => api.get<{ data: DlqRow[]; counts?: Record<string, number> }>('/dlq'),
  });
  const replay = useMutation({
    mutationFn: (id: string) => api.post(`/dlq/${id}/replay`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dlq'] }),
  });
  const rows = data?.data ?? [];
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h2 className="text-base font-semibold">Event queue — dead letters</h2>
        <p className="text-sm text-muted-foreground">Events that exhausted retries. Replay after fixing the underlying issue; delivery is idempotent.</p>
      </div>
      {isLoading ? <Skeleton className="h-32" /> : isError ? (
        <EmptyState title="Requires settings.manage + audit.read" />
      ) : rows.length === 0 ? (
        <EmptyState title="Queue is healthy" hint="No dead-lettered events. Failed handlers retry automatically with backoff before landing here." />
      ) : (
        <Card className="divide-y divide-border">
          {rows.map((r) => (
            <div key={r.id} className="flex items-start gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge className="bg-muted text-muted-foreground">{r.consumer}</Badge>
                  <span className="truncate font-mono text-xs text-muted-foreground">{r.eventId}</span>
                  <span className="text-xs text-muted-foreground">×{r.attempts}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-destructive">{r.error}</p>
              </div>
              <Button size="sm" variant="outline" disabled={replay.isPending} onClick={() => replay.mutate(r.id)}>Replay</Button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
