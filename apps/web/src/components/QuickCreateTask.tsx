import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Input, Select } from './ui';
import { useT } from '../lib/i18n';

interface ProjectLite { id: string; name: string; key: string }

/** Parse quick syntax in the title (PRD §8.3): `!high` priority token. */
function parseQuickSyntax(raw: string): { title: string; priority?: string } {
  let title = raw;
  let priority: string | undefined;
  const m = title.match(/!(urgent|high|medium|low|none)\b/i);
  if (m) {
    priority = m[1]!.toLowerCase();
    title = title.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
  }
  return { title, priority };
}

export function QuickCreateTask({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');

  const projectsQ = useQuery<ProjectLite[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<{ data: ProjectLite[] }>('/projects').then((r) => r.data),
    enabled: open,
  });
  const projects = projectsQ.data ?? [];

  useEffect(() => {
    if (open && !projectId && projects.length) setProjectId(projects[0]!.id);
  }, [open, projects, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (open) window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const create = useMutation({
    mutationFn: () => {
      const parsed = parseQuickSyntax(title);
      return api.post('/tasks', {
        projectId, title: parsed.title, priority: parsed.priority ?? 'none',
        assigneeIds: [], labelIds: [],
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['me-tasks'] });
      setTitle('');
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-32" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-sm font-semibold">{t('tasks.newTask')}</h2>
        <div className="space-y-2">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-full">
            {projects.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
          </Select>
          <Input autoFocus placeholder={t('tasks.quickTitlePlaceholder')} value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && title.trim() && projectId) create.mutate(); }} />
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" disabled={!title.trim() || !projectId || create.isPending} onClick={() => create.mutate()}>{t('common.create')}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
