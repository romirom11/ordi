import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X, FolderKanban } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { Button, Input, Select, Card, Badge, PageHeader, Skeleton, EmptyState, Spinner } from '../components/ui';

interface Project {
  id: string; name: string; key: string; kind: 'client' | 'internal';
  status: string; companyId?: string | null; companyName?: string | null;
}
interface CompanyLite { id: string; name: string }

const STATUS_COLOR: Record<string, string> = {
  active: '#22c55e', paused: '#eab308', completed: '#3b82f6', archived: '#9ca3af',
};

export function ProjectsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const canCreate = can('projects.create');
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<Project[]>('/projects'),
  });
  const projects = data ?? [];

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Client and internal work"
        actions={canCreate && <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> New project</Button>}
      />

      <div className="p-6">
        {isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-28" />)}</div>
        ) : projects.length === 0 ? (
          <EmptyState
            title="No projects yet"
            hint="Create a project to organize tasks, cycles, and docs. Client projects link to a company; internal ones stand alone."
            action={canCreate ? <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> New project</Button> : undefined}
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <button key={p.id} onClick={() => navigate(`/projects/${p.id}`)} className="text-left">
                <Card className="h-full p-4 transition-colors hover:border-primary/50">
                  <div className="mb-2 flex items-center gap-2">
                    <Badge className="bg-muted font-mono text-muted-foreground">{p.key}</Badge>
                    <Badge color={STATUS_COLOR[p.status]}>{p.status}</Badge>
                    <span className="ml-auto text-xs capitalize text-muted-foreground">{p.kind}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <FolderKanban size={16} className="shrink-0 text-muted-foreground" />
                    <span className="font-medium">{p.name}</span>
                  </div>
                  {p.companyName && <p className="mt-1 pl-6 text-xs text-muted-foreground">{p.companyName}</p>}
                </Card>
              </button>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); qc.invalidateQueries({ queryKey: ['projects'] }); navigate(`/projects/${id}`); }}
        />
      )}
    </div>
  );
}

function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const canCrm = useCan()('crm.read');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [kind, setKind] = useState<'client' | 'internal'>('client');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const companiesQ = useQuery<CompanyLite[]>({
    queryKey: ['companies', 'lite'],
    queryFn: () => api.get<CompanyLite[]>('/companies'),
    enabled: canCrm && kind === 'client',
  });
  const companies = companiesQ.data ?? [];

  const mut = useMutation({
    mutationFn: () => api.post<Project>('/projects', {
      name, key, kind, companyId: kind === 'client' ? (companyId || undefined) : undefined,
    }),
    onSuccess: (p) => onCreated(p.id),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create project.'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!/^[A-Z]{2,5}$/.test(key)) { setError('Key must be 2–5 uppercase letters.'); return; }
    if (kind === 'client' && !companyId) { setError('Pick a client for a client project.'); return; }
    mut.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">New project</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing site" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Key</label>
              <Input
                value={key}
                onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5))}
                placeholder="MKT"
                className="font-mono uppercase"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Kind</label>
              <Select value={kind} onChange={(e) => setKind(e.target.value as 'client' | 'internal')} className="w-full">
                <option value="client">Client</option>
                <option value="internal">Internal</option>
              </Select>
            </div>
          </div>
          {kind === 'client' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Client</label>
              {canCrm ? (
                <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-full">
                  <option value="">{companiesQ.isLoading ? 'Loading…' : 'Select a client…'}</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              ) : (
                <Input value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="Company ID" />
              )}
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : 'Create'}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
