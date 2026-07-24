/**
 * Project status updates: "Write first project update" card, composer with a
 * health segmented control (On track / At risk / Off track), and the feed.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, MoreHorizontal, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { Avatar, Button, SegmentedControl, Skeleton, Spinner, fmtRelative, cn } from '../ui';
import { ConfirmDialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { RichEditor, EMPTY_DOC } from '../richtext/RichEditor';
import { RichBody } from '../task/RichBody';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'projects.updates': 'Project updates',
    'projects.firstUpdate': 'Write first project update',
    'projects.firstUpdateHint': 'Keep the team and stakeholders posted on health and progress.',
    'projects.newUpdate': 'New update',
    'projects.updatePh': 'What changed since the last update?',
    'projects.postUpdate': 'Post update',
    'projects.healthOnTrack': 'On track',
    'projects.healthAtRisk': 'At risk',
    'projects.healthOffTrack': 'Off track',
    'projects.updatePosted': 'Update posted',
    'projects.updateDeleted': 'Update deleted',
    'projects.deleteUpdate': 'Delete update',
    'projects.deleteUpdateBody': 'This permanently deletes this project update.',
    'projects.updateFailed': 'Could not save the update.',
  },
  uk: {
    'projects.updates': 'Оновлення проєкту',
    'projects.firstUpdate': 'Напишіть перше оновлення проєкту',
    'projects.firstUpdateHint': 'Тримайте команду та стейкхолдерів у курсі стану і прогресу.',
    'projects.newUpdate': 'Нове оновлення',
    'projects.updatePh': 'Що змінилося від минулого оновлення?',
    'projects.postUpdate': 'Опублікувати',
    'projects.healthOnTrack': 'За планом',
    'projects.healthAtRisk': 'Є ризики',
    'projects.healthOffTrack': 'Поза планом',
    'projects.updatePosted': 'Оновлення опубліковано',
    'projects.updateDeleted': 'Оновлення видалено',
    'projects.deleteUpdate': 'Видалити оновлення',
    'projects.deleteUpdateBody': 'Це назавжди видалить це оновлення проєкту.',
    'projects.updateFailed': 'Не вдалося зберегти оновлення.',
  },
});

type Health = 'on_track' | 'at_risk' | 'off_track';

export const HEALTH_META: Record<Health, { color: string; key: string }> = {
  on_track: { color: '#22c55e', key: 'projects.healthOnTrack' },
  at_risk: { color: '#eab308', key: 'projects.healthAtRisk' },
  off_track: { color: '#ef4444', key: 'projects.healthOffTrack' },
};

interface ProjectUpdate {
  id: string; projectId: string; body: unknown; health: Health;
  createdBy?: string | null; createdAt: string;
  authorName?: string | null; authorAvatar?: string | null;
}

function docHasText(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const node = doc as { text?: string; content?: unknown[] };
  if (typeof node.text === 'string' && node.text.trim() !== '') return true;
  return (node.content ?? []).some((c) => docHasText(c));
}

function HealthDot({ health, withLabel, size = 8 }: { health: Health; withLabel?: boolean; size?: number }) {
  const t = useT();
  const meta = HEALTH_META[health] ?? HEALTH_META.on_track;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="rounded-full" style={{ width: size, height: size, backgroundColor: meta.color }} />
      {withLabel && <span className="text-xs" style={{ color: meta.color }}>{t(meta.key)}</span>}
    </span>
  );
}

export function ProjectUpdates({ projectId, canWrite, isAdmin }: {
  projectId: string; canWrite: boolean; isAdmin: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState<unknown>(EMPTY_DOC);
  const [health, setHealth] = useState<Health>('on_track');
  const [composerKey, setComposerKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const { data, isLoading } = useQuery<ProjectUpdate[]>({
    queryKey: ['project-updates', projectId],
    queryFn: () => api.get<{ data: ProjectUpdate[] }>(`/projects/${projectId}/updates`).then((r) => r.data),
  });
  const updates = useMemo(() => data ?? [], [data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['project-updates', projectId] });
    qc.invalidateQueries({ queryKey: ['project-audit', projectId] });
  };

  const post = useMutation({
    mutationFn: () => api.post(`/projects/${projectId}/updates`, { body: draft, health }),
    onSuccess: () => {
      setDraft(EMPTY_DOC); setHealth('on_track'); setComposing(false); setComposerKey((k) => k + 1);
      invalidate();
      toast(t('projects.updatePosted'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('projects.updateFailed')),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/project-updates/${id}`),
    onSuccess: () => { setPendingDelete(null); invalidate(); toast(t('projects.updateDeleted')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('projects.updateFailed')),
  });

  const canSend = docHasText(draft);
  const healthOptions = (Object.keys(HEALTH_META) as Health[]).map((h) => ({
    key: h,
    label: (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: HEALTH_META[h].color }} />
        {t(HEALTH_META[h].key)}
      </span>
    ),
  }));

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('projects.updates')}</h2>

      {isLoading ? (
        <Skeleton className="h-16" />
      ) : (
        <div className="space-y-2.5">
          {/* Composer / call to action */}
          {canWrite && !composing && (
            <button
              type="button"
              onClick={() => setComposing(true)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-left',
                'text-[13px] text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:bg-muted/50 hover:text-foreground',
              )}
            >
              <MessageSquarePlus size={15} className="shrink-0 text-faint" />
              <span className="min-w-0">
                <span className="block font-medium">
                  {updates.length === 0 ? t('projects.firstUpdate') : t('projects.newUpdate')}
                </span>
                {updates.length === 0 && <span className="block text-xs text-faint">{t('projects.firstUpdateHint')}</span>}
              </span>
            </button>
          )}

          {canWrite && composing && (
            <div className="anim-fade-in rounded-lg border border-border bg-card p-3">
              <RichEditor
                key={composerKey}
                value={draft}
                onChange={setDraft}
                placeholder={t('projects.updatePh')}
                compact
                onSubmit={() => { if (canSend && !post.isPending) post.mutate(); }}
              />
              <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                <SegmentedControl options={healthOptions} value={health} onChange={setHealth} />
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setComposing(false); setDraft(EMPTY_DOC); setComposerKey((k) => k + 1); }}>
                    {t('common.cancel')}
                  </Button>
                  <Button size="sm" disabled={!canSend || post.isPending} onClick={() => post.mutate()}>
                    {post.isPending ? <Spinner /> : t('projects.postUpdate')}
                  </Button>
                </span>
              </div>
            </div>
          )}

          {/* Feed */}
          {updates.map((u, i) => {
            const canDelete = isAdmin || u.createdBy === me.user.id;
            return (
              <div
                key={u.id}
                className="row-enter rounded-lg border border-border bg-card px-3 py-2.5 transition-colors duration-150 hover:border-border-strong"
                style={{ ['--i' as string]: Math.min(i, 10) }}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  <Avatar name={u.authorName ?? undefined} src={u.authorAvatar} size={20} />
                  <span className="text-[13px] font-medium">{u.authorName ?? t('common.someone')}</span>
                  <HealthDot health={u.health} withLabel />
                  <span className="ml-auto text-[11px] text-faint">{fmtRelative(u.createdAt)}</span>
                  {canDelete && (
                    <DropdownMenu
                      align="end"
                      width={180}
                      trigger={
                        <button type="button" className="rounded p-0.5 text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground" aria-label={t('common.delete')}>
                          <MoreHorizontal size={14} />
                        </button>
                      }
                    >
                      <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setPendingDelete(u.id)}>
                        {t('projects.deleteUpdate')}
                      </MenuItem>
                    </DropdownMenu>
                  )}
                </div>
                <RichBody doc={u.body} className="text-[13px]" />
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete != null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => { if (pendingDelete) del.mutate(pendingDelete); }}
        title={t('projects.deleteUpdate')}
        body={t('projects.deleteUpdateBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </section>
  );
}
