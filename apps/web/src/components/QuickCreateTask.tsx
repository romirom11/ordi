/**
 * Quick task creation (global "C" shortcut). Linear-style compact dialog:
 * project + priority pickers as dropdowns, `!high`-style tokens in the title.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FolderKanban } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Button, Input, Kbd, PriorityIcon, Spinner, cn } from './ui';
import { Dialog, DropdownMenu, MenuItem, MenuLabel, toast } from './overlays';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'tasks.project': 'Project',
    'tasks.createdToast': 'Task created',
    'task.priority.urgent': 'Urgent',
    'task.priority.high': 'High',
    'task.priority.medium': 'Medium',
    'task.priority.low': 'Low',
    'task.priority.none': 'No priority',
  },
  uk: {
    'tasks.project': 'Проєкт',
    'tasks.createdToast': 'Задачу створено',
    'task.priority.urgent': 'Терміновий',
    'task.priority.high': 'Високий',
    'task.priority.medium': 'Середній',
    'task.priority.low': 'Низький',
    'task.priority.none': 'Без пріоритету',
  },
});

interface ProjectLite { id: string; name: string; key: string }
interface CreatedTask { id: string; ref?: string; title: string }

const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;

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
  const [priority, setPriority] = useState<string>('none');
  const [title, setTitle] = useState('');

  const projectsQ = useQuery<ProjectLite[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<{ data: ProjectLite[] }>('/projects').then((r) => r.data),
    enabled: open,
  });
  const projects = projectsQ.data ?? [];
  const project = projects.find((p) => p.id === projectId);

  useEffect(() => {
    if (open && !projectId && projects.length) setProjectId(projects[0]!.id);
  }, [open, projects, projectId]);

  useEffect(() => {
    if (!open) { setTitle(''); setPriority('none'); }
  }, [open]);

  const parsed = parseQuickSyntax(title);
  const effectivePriority = parsed.priority ?? priority;

  const create = useMutation({
    mutationFn: () => api.post<CreatedTask>('/tasks', {
      projectId,
      title: parsed.title,
      priority: effectivePriority,
      assigneeIds: [],
      labelIds: [],
    }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['me-tasks'] });
      qc.invalidateQueries({ queryKey: ['subtasks'] });
      toast(`${created.ref ?? ''} ${t('tasks.createdToast').toLowerCase()}`.trim());
      onClose();
    },
    onError: (e: Error) => toast.error(e instanceof ApiError ? e.message : t('tasks.createFailed')),
  });
  const canCreate = parsed.title.trim() !== '' && !!projectId && !create.isPending;

  return (
    <Dialog open={open} onClose={onClose} title={t('tasks.newTask')} width={520}>
      <div className="px-4 pb-4 pt-3">
        <Input
          autoFocus
          placeholder={t('tasks.quickTitlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canCreate) create.mutate(); }}
          className="h-9 border-none px-1 text-[15px] font-medium focus:ring-0"
        />

        <div className="mt-2.5 flex items-center gap-1.5">
          {/* Project picker */}
          <DropdownMenu
            width={260}
            trigger={
              <button className={cn(
                'flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[13px]',
                'transition-colors duration-150 hover:border-border-strong hover:bg-muted',
              )}>
                {projectsQ.isLoading ? <Spinner className="h-3 w-3" /> : <FolderKanban size={13} className="text-muted-foreground" />}
                <span className="max-w-[180px] truncate">
                  {project ? project.name : t('tasks.project')}
                </span>
                {project && <span className="font-mono text-[10px] text-faint">{project.key}</span>}
                <ChevronDown size={12} className="text-faint" />
              </button>
            }
          >
            <MenuLabel>{t('tasks.project')}</MenuLabel>
            {projects.map((p) => (
              <MenuItem
                key={p.id}
                icon={<FolderKanban size={14} />}
                checked={p.id === projectId}
                onSelect={() => setProjectId(p.id)}
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="truncate">{p.name}</span>
                  <span className="font-mono text-[10px] text-faint">{p.key}</span>
                </span>
              </MenuItem>
            ))}
          </DropdownMenu>

          {/* Priority picker */}
          <DropdownMenu
            width={180}
            trigger={
              <button className={cn(
                'flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-[13px]',
                'transition-colors duration-150 hover:border-border-strong hover:bg-muted',
              )}>
                <PriorityIcon priority={effectivePriority} />
                <span className={cn(effectivePriority === 'none' && 'text-muted-foreground')}>
                  {t(`task.priority.${effectivePriority}`)}
                </span>
                <ChevronDown size={12} className="text-faint" />
              </button>
            }
          >
            {PRIORITIES.map((p) => (
              <MenuItem
                key={p}
                icon={<PriorityIcon priority={p} />}
                checked={p === effectivePriority}
                onSelect={() => setPriority(p)}
              >
                {t(`task.priority.${p}`)}
              </MenuItem>
            ))}
          </DropdownMenu>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-3">
          <span className="flex items-center gap-1.5 text-[11px] text-faint">
            <Kbd>↵</Kbd> {t('common.create')}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button size="sm" disabled={!canCreate} onClick={() => create.mutate()}>
              {create.isPending && <Spinner className="h-3 w-3 border-white/40 border-t-white" />}
              {t('common.create')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
