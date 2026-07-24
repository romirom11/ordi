/**
 * Activity section of the task page: comments and audit-log events merged into
 * a single chronological timeline, with a rich comment composer at the bottom.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Avatar, Button, Kbd, fmtRelative } from '../ui';
import { toast } from '../overlays';
import { RichEditor, EMPTY_DOC } from '../richtext/RichEditor';
import { useT, extendDict } from '../../lib/i18n';
import { RichBody } from './RichBody';
import type { AuditEntry, TaskComment, UserLite } from './types';

extendDict({
  en: {
    'task.activity': 'Activity',
    'task.activity.created': 'created this task',
    'task.activity.updated': 'updated this task',
    'task.activity.deleted': 'deleted this task',
    'task.activity.restored': 'restored this task',
    'task.noActivity': 'No activity yet – start the conversation below.',
  },
  uk: {
    'task.activity': 'Активність',
    'task.activity.created': 'створює задачу',
    'task.activity.updated': 'оновлює задачу',
    'task.activity.deleted': 'видаляє задачу',
    'task.activity.restored': 'відновлює задачу',
    'task.noActivity': 'Активності поки немає – почніть обговорення нижче.',
  },
});

type TimelineItem =
  | { kind: 'comment'; at: string; comment: TaskComment }
  | { kind: 'audit'; at: string; entry: AuditEntry };

function docHasText(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const node = doc as { text?: string; content?: unknown[] };
  if (typeof node.text === 'string' && node.text.trim() !== '') return true;
  return (node.content ?? []).some((c) => docHasText(c));
}

export function ActivityFeed({ taskId, comments, users }: {
  taskId: string; comments: TaskComment[]; users: UserLite[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<unknown>(EMPTY_DOC);
  const [composerKey, setComposerKey] = useState(0);

  const auditQ = useQuery({
    queryKey: ['task-audit', taskId],
    queryFn: () => api.get<{ data: AuditEntry[] }>(`/audit/entity/task/${taskId}`).then((r) => r.data),
  });

  const nameOf = useMemo(() => {
    const map = new Map(users.map((u) => [u.id, u.name]));
    return (id?: string | null) => (id ? map.get(id) : undefined) ?? t('common.someone');
  }, [users, t]);

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...comments.map((c): TimelineItem => ({ kind: 'comment', at: c.createdAt, comment: c })),
      ...(auditQ.data ?? []).map((e): TimelineItem => ({ kind: 'audit', at: e.createdAt, entry: e })),
    ];
    items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    // Collapse runs of identical audit events (same actor + action) into the latest one.
    return items.filter((item, i) => {
      if (item.kind !== 'audit') return true;
      const next = items[i + 1];
      return !(next && next.kind === 'audit'
        && next.entry.actorId === item.entry.actorId
        && next.entry.action === item.entry.action);
    });
  }, [comments, auditQ.data]);

  const canSend = docHasText(draft);

  const addComment = useMutation({
    mutationFn: () => api.post(`/tasks/${taskId}/comments`, { body: draft }),
    onSuccess: () => {
      setDraft(EMPTY_DOC);
      setComposerKey((k) => k + 1); // remount the editor to clear it even while focused
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['task-audit', taskId] });
    },
    onError: (e: Error) => toast.error(e instanceof ApiError ? e.message : t('tasks.addCommentFailed')),
  });
  const submit = () => { if (canSend && !addComment.isPending) addComment.mutate(); };

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('task.activity')}</h2>

      {timeline.length === 0 && !auditQ.isLoading && (
        <p className="mb-3 flex items-center gap-2 text-[13px] text-faint">
          <MessageSquare size={14} /> {t('task.noActivity')}
        </p>
      )}

      <div className="mb-4 space-y-1">
        {timeline.map((item, i) => (
          item.kind === 'comment' ? (
            <div
              key={`c-${item.comment.id}`}
              className="row-enter flex gap-2.5 py-1.5"
              style={{ ['--i' as string]: Math.min(i, 10) }}
            >
              <Avatar name={item.comment.authorName ?? nameOf(item.comment.authorId)} size={22} className="mt-0.5" />
              <div className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 transition-colors duration-150 hover:border-border-strong">
                <p className="mb-1 flex items-baseline gap-2">
                  <span className="text-[13px] font-medium">{item.comment.authorName ?? nameOf(item.comment.authorId)}</span>
                  <span className="text-[11px] text-faint">{fmtRelative(item.comment.createdAt)}</span>
                </p>
                <RichBody doc={item.comment.body} className="text-[13px]" />
              </div>
            </div>
          ) : (
            <div
              key={`a-${item.entry.id}`}
              className="row-enter flex items-center gap-2.5 py-1 pl-[7px]"
              style={{ ['--i' as string]: Math.min(i, 10) }}
            >
              <span className="mx-1 h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" />
              <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                <span className="font-medium text-foreground/80">{nameOf(item.entry.actorId)}</span>{' '}
                {t(`task.activity.${item.entry.action}`, item.entry.action)}
                <span className="text-faint"> · {fmtRelative(item.entry.createdAt)}</span>
              </p>
            </div>
          )
        ))}
      </div>

      {/* Composer */}
      <div className="rounded-lg">
        <RichEditor
          key={composerKey}
          value={draft}
          onChange={setDraft}
          placeholder={t('tasks.writeComment')}
          compact
          onSubmit={submit}
        />
        <div className="mt-2 flex items-center justify-end gap-2.5">
          <span className="flex items-center gap-1 text-[11px] text-faint">
            <Kbd>⌘</Kbd><Kbd>↵</Kbd>
          </span>
          <Button size="sm" disabled={!canSend || addComment.isPending} onClick={submit}>
            {t('tasks.comment')}
          </Button>
        </div>
      </div>
    </section>
  );
}
