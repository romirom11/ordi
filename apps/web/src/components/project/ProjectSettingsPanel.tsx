import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Settings, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useCan, useProjectRole } from '../../lib/auth';
import { Button, Input, Skeleton, Spinner, Switch, cn } from '../ui';
import { ConfirmDialog, SidePanel, toast } from '../overlays';
import { ProjectAccessPanel } from '../ProjectAccessPanel';
import { CustomFieldsPanel } from '../settings/CustomFieldsPanel';
import { IntakeSettingsSection } from './ProjectIntake';
import { ProjectAutomationSection } from './ProjectAutomation';
import { ProjectIntegrations } from './ProjectIntegrations';
import { PROJECT_STATUSES, STATUS_META } from './pickers';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'projects.general': 'General',
    'projects.access': 'Access',
    'projects.conflict': 'This project changed elsewhere – reloaded the latest version.',
    'projects.cyclesToggleHint': 'Time-boxed sprints in the Plan tab, a Cycle field on tasks and cycle filters. Off for projects that do not work in sprints.',
    'projects.dangerZone': 'Danger zone',
    'projects.deleteProject': 'Delete project',
    'projects.deleteProjectHint': 'Hides the project and its tasks from everyone until it is restored from Deleted projects. To only put it out of the way, set its status to Archived instead.',
    'projects.deleteProjectBody': 'The project and all its tasks disappear for everyone; running timers are saved and agent runs stop. It can be restored from Deleted projects on the Projects page. To only put it out of the way, set its status to Archived instead.',
    'projects.deleted': 'Project deleted',
  },
  uk: {
    'projects.general': 'Загальні',
    'projects.access': 'Доступ',
    'projects.conflict': 'Проєкт змінено деінде – завантажено найновішу версію.',
    'projects.cyclesToggleHint': 'Спринти у вкладці «План», поле «Цикл» у задачах і фільтр за циклом. Вимкніть, якщо проєкт не працює спринтами.',
    'projects.dangerZone': 'Небезпечна зона',
    'projects.deleteProject': 'Видалити проєкт',
    'projects.deleteProjectHint': 'Проєкт і його задачі зникнуть для всіх, доки його не відновлять з «Видалених проєктів». Якщо треба лише прибрати його з очей, поставте статус «Архів».',
    'projects.deleteProjectBody': 'Проєкт і всі його задачі зникнуть для всіх; запущені таймери збережуться, запуски агентів зупиняться. Відновити його можна з «Видалених проєктів» на сторінці проєктів. Якщо треба лише прибрати його з очей, поставте статус «Архів».',
    'projects.deleted': 'Проєкт видалено',
  },
});

/** The fields the settings panel reads; the full project record carries more. */
export interface SettingsProject {
  id: string; name: string; key: string; status: string;
  visibility?: 'workspace' | 'private'; version?: number; settings?: Record<string, unknown>;
  cyclesEnabled?: boolean;
}

/**
 * PATCH /projects/:id with the optimistic-concurrency version, refreshing every
 * cache that shows the project. A 409 reloads the record and says so.
 */
export function useProjectPatch(id: string, version: number | undefined) {
  const t = useT();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/projects/${id}`, { ...body, version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-audit', id] });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) {
        qc.invalidateQueries({ queryKey: ['project', id] });
        toast.error(t('projects.conflict'));
      } else {
        toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
      }
    },
  });
}

/**
 * Project settings as a side panel. It loads the project itself, so the
 * project list can open it in place instead of navigating to the project page.
 */
export function ProjectSettingsPanel({ projectId, open, onClose, onDeleted }: {
  projectId: string | null; open: boolean; onClose: () => void;
  /** Called after a successful delete; the panel is closed by then. */
  onDeleted?: () => void;
}) {
  const t = useT();
  const projectQ = useQuery<SettingsProject>({
    queryKey: ['project', projectId],
    queryFn: () => api.get<SettingsProject>(`/projects/${projectId}`),
    enabled: !!projectId,
  });
  const project = projectQ.data;

  return (
    <SidePanel open={open} onClose={onClose} title={t('nav.settings')} subtitle={project?.name} icon={<Settings size={16} />} width={640}>
      {projectId && (
        <ProjectSettings
          key={projectId}
          projectId={projectId}
          project={project}
          onDeleted={() => { onClose(); onDeleted?.(); }}
        />
      )}
    </SidePanel>
  );
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="w-64 shrink-0">{children}</div>
    </div>
  );
}

function ProjectSettings({ projectId, project, onDeleted }: {
  projectId: string; project?: SettingsProject; onDeleted: () => void;
}) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const role = useProjectRole(projectId, project?.visibility);
  const isAdmin = role === 'admin';
  // The API wants both: project admin rights and the workspace delete permission.
  const canDelete = isAdmin && can('projects.delete');
  const canManageIntegrations = can('integrations.manage');
  const patch = useProjectPatch(projectId, project?.version);
  const onPatch = (body: Record<string, unknown>) => patch.mutate(body);

  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (project) setName(project.name ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const del = useMutation({
    mutationFn: () => api.del(`/projects/${projectId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.removeQueries({ queryKey: ['project', projectId] });
      toast(t('projects.deleted'));
      setConfirmDelete(false);
      onDeleted();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  if (!project) return <Skeleton className="h-40" />;

  const saveName = () => {
    setError(null);
    if (!name.trim()) { setError(t('common.nameRequired')); return; }
    if (name.trim() !== project.name) onPatch({ name: name.trim() });
  };

  return (
    <div className="space-y-8">
      {/* General */}
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('projects.general')}</h2>
        <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
          <SettingRow label={t('common.name')}>
            <div className="flex gap-2">
              <Input value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} onBlur={saveName}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </div>
          </SettingRow>
          <SettingRow label={t('projects.key')} hint={t('projects.keyImmutable')}>
            <Input value={project.key} disabled className="font-mono" />
          </SettingRow>
          <SettingRow label={t('common.status')}>
            <div className="flex flex-wrap gap-1.5">
              {PROJECT_STATUSES.map((s) => (
                <button key={s} disabled={!isAdmin} onClick={() => { if (s !== project.status) onPatch({ status: s }); }}
                  className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                    project.status === s ? 'border-border-strong bg-muted text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted',
                    !isAdmin && 'pointer-events-none opacity-60')}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STATUS_META[s]!.color }} />
                  {t(STATUS_META[s]!.key)}
                </button>
              ))}
            </div>
          </SettingRow>
          {/* Cycles are opt-in: projects that do not work in sprints never see them. */}
          <SettingRow label={t('plan.cycles')} hint={t('projects.cyclesToggleHint')}>
            <div className="flex justify-end">
              <Switch checked={!!project.cyclesEnabled} disabled={!isAdmin} onChange={(v) => onPatch({ settings: { cycles: v } })} label={t('plan.cycles')} />
            </div>
          </SettingRow>
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        {!isAdmin && <p className="mt-2 text-xs text-muted-foreground">{t('projects.adminRightsHint')}</p>}
        {patch.isPending && <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner className="h-3 w-3" /> {t('common.loading')}</p>}
      </section>

      {/* Access */}
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('projects.access')}</h2>
        <ProjectAccessPanel projectId={project.id} canManage={isAdmin} />
      </section>

      {/* Intake form, project task fields + task automation – the endpoints demand project admin. */}
      {isAdmin && (
        <>
          <section>
            <CustomFieldsPanel projectId={project.id} />
          </section>
          <IntakeSettingsSection projectId={project.id} projectName={project.name} />
          <ProjectAutomationSection projectId={project.id} />
        </>
      )}

      {/* Integrations */}
      <ProjectIntegrations
        projectId={project.id}
        settings={project.settings}
        version={project.version}
        canManage={canManageIntegrations}
      />

      {/* Last, so nobody reaches it by scrolling past what they came for. */}
      {canDelete && (
        <section>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-destructive">{t('projects.dangerZone')}</h2>
          <div className="rounded-lg border border-destructive/30 bg-card px-4">
            <SettingRow label={t('projects.deleteProject')} hint={t('projects.deleteProjectHint')}>
              <div className="flex justify-end">
                <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> {t('projects.deleteProject')}
                </Button>
              </div>
            </SettingRow>
          </div>
          <ConfirmDialog
            open={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => del.mutate()}
            title={project.name}
            body={t('projects.deleteProjectBody')}
            confirmLabel={t('projects.deleteProject')}
            danger
            pending={del.isPending}
          />
        </section>
      )}
    </div>
  );
}
