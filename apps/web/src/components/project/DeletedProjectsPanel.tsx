import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useNavigate } from '../../lib/router';
import { Button, EmptyState, Skeleton, fmtDate } from '../ui';
import { SidePanel, toast } from '../overlays';
import { ProjectIcon } from './ProjectIcon';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'projects.trash': 'Deleted projects',
    'projects.trashHint': 'A deleted project keeps its tasks, time and files. Restoring it brings everything back, including recurring tasks and intake.',
    'projects.trashEmpty': 'No deleted projects',
    'projects.deletedOn': 'Deleted {date}',
    'projects.restore': 'Restore',
    'projects.restored': 'Project restored',
    'projects.openRestored': 'Open',
  },
  uk: {
    'projects.trash': 'Видалені проєкти',
    'projects.trashHint': 'Видалений проєкт зберігає задачі, час і файли. Відновлення повертає все, разом із повторюваними задачами та intake.',
    'projects.trashEmpty': 'Видалених проєктів немає',
    'projects.deletedOn': 'Видалено {date}',
    'projects.restore': 'Відновити',
    'projects.restored': 'Проєкт відновлено',
    'projects.openRestored': 'Відкрити',
  },
});

interface DeletedProject { id: string; name: string; key: string; deletedAt: string }

/** The trash: projects this person deleted (or administers) and may bring back. */
export function DeletedProjectsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const deletedQ = useQuery<DeletedProject[]>({
    queryKey: ['projects', 'deleted'],
    queryFn: () => api.get<{ data: DeletedProject[] }>('/projects/deleted').then((r) => r.data),
    enabled: open,
  });

  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${id}/restore`, {}),
    onSuccess: (_r, id) => {
      // ['projects'] is a prefix of ['projects', 'deleted']: both lists refresh.
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project', id] });
      toast.action(t('projects.restored'), { label: t('projects.openRestored'), onSelect: () => navigate(`/projects/${id}`) }, 'success');
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const rows = deletedQ.data ?? [];

  return (
    <SidePanel open={open} onClose={onClose} title={t('projects.trash')} icon={<Trash2 size={16} />} width={520}>
      <p className="mb-4 text-[13px] text-muted-foreground">{t('projects.trashHint')}</p>
      {deletedQ.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Trash2 size={20} />} title={t('projects.trashEmpty')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {rows.map((p, i) => (
            <div key={p.id} className={i > 0 ? 'flex items-center gap-3 border-t border-border px-4 py-2.5' : 'flex items-center gap-3 px-4 py-2.5'}>
              <ProjectIcon seed={p.key || p.id} size={24} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{p.name} <span className="font-mono text-[11px] text-faint">{p.key}</span></p>
                <p className="text-xs text-muted-foreground">{t('projects.deletedOn').replace('{date}', fmtDate(p.deletedAt))}</p>
              </div>
              <Button size="sm" variant="outline" disabled={restore.isPending} onClick={() => restore.mutate(p.id)}>
                <RotateCcw size={14} /> {t('projects.restore')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </SidePanel>
  );
}
