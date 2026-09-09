/**
 * Activity section of the task page: comments and audit-log events merged into
 * a single chronological timeline, with a rich comment composer at the bottom.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Pencil, SmilePlus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMe, type ProjectRole } from '../../lib/auth';
import { Avatar, Button, IconButton, Kbd, cn, fmtRelative } from '../ui';
import { DropdownMenu, toast, useMenuClose } from '../overlays';
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
    'task.react': 'Add reaction',
    'task.reactFailed': 'Could not update the reaction',
    'task.editComment': 'Edit comment',
    'task.commentEdited': 'edited',
    'task.editCommentFailed': 'Could not save the comment',
  },
  uk: {
    'task.activity': 'Активність',
    'task.activity.created': 'створює задачу',
    'task.activity.updated': 'оновлює задачу',
    'task.activity.deleted': 'видаляє задачу',
    'task.activity.restored': 'відновлює задачу',
    'task.noActivity': 'Активності поки немає – почніть обговорення нижче.',
    'task.react': 'Додати реакцію',
    'task.reactFailed': 'Не вдалося оновити реакцію',
    'task.editComment': 'Редагувати коментар',
    'task.commentEdited': 'відредаговано',
    'task.editCommentFailed': 'Не вдалося зберегти коментар',
  },
});

/** The quick palette – the reactions a work chat actually uses. */
const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🔥', '🙏', '👀', '✅'];

type TimelineItem =
  | { kind: 'comment'; at: string; comment: TaskComment }
  | { kind: 'audit'; at: string; entry: AuditEntry };

function docHasText(doc: unknown): boolean {
  if (!doc || typeof doc !== 'object') return false;
  const node = doc as { text?: string; content?: unknown[] };
  if (typeof node.text === 'string' && node.text.trim() !== '') return true;
  return (node.content ?? []).some((c) => docHasText(c));
}

/**
 * Slack-style reactions under a comment: existing ones as chips (click
 * toggles yours), a smile button opens the quick palette. Who reacted sits in
 * the chip's tooltip – enough without a hover-card.
 */
function ReactionBar({ taskId, comment, users }: {
  taskId: string; comment: TaskComment; users: UserLite[];
}) {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();

  const toggle = useMutation({
    mutationFn: (emoji: string) => api.post(`/comments/${comment.id}/reactions`, { emoji }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['task', taskId] }),
    onError: (e: Error) => toast.error(e instanceof ApiError ? e.message : t('task.reactFailed')),
  });

  const nameOf = (id: string) => users.find((u) => u.id === id)?.name ?? t('common.someone');
  const entries = Object.entries(comment.reactions ?? {}).filter(([, ids]) => ids.length > 0);
  if (entries.length === 0) {
    // No bar until someone reacts – the smile shows on hover of the comment.
    return (
      <div className="mt-1 flex opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/comment:opacity-100">
        <ReactionPicker onPick={(e) => toggle.mutate(e)} label={t('task.react')} />
      </div>
    );
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {entries.map(([emoji, ids]) => {
        const mine = me.user ? ids.includes(me.user.id) : false;
        return (
          <button
            key={emoji}
            type="button"
            title={ids.map(nameOf).join(', ')}
            disabled={toggle.isPending}
            onClick={() => toggle.mutate(emoji)}
            className={cn(
              'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors duration-150',
              mine
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border bg-surface text-muted-foreground hover:border-border-strong',
            )}
          >
            <span>{emoji}</span>
            <span className="tabular-nums">{ids.length}</span>
          </button>
        );
      })}
      <ReactionPicker onPick={(e) => toggle.mutate(e)} label={t('task.react')} />
    </div>
  );
}

function ReactionPicker({ onPick, label }: { onPick: (emoji: string) => void; label: string }) {
  return (
    <DropdownMenu
      trigger={
        <span
          role="button"
          tabIndex={0}
          aria-label={label}
          title={label}
          className="grid h-[22px] w-[22px] cursor-pointer place-items-center rounded-full border border-border text-faint transition-colors duration-150 hover:border-border-strong hover:text-foreground"
        >
          <SmilePlus size={12} />
        </span>
      }
    >
      <ReactionPalette onPick={onPick} />
    </DropdownMenu>
  );
}

function ReactionPalette({ onPick }: { onPick: (emoji: string) => void }) {
  const closeMenu = useMenuClose();
  return (
    <div className="grid grid-cols-5">
      {QUICK_EMOJI.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => { onPick(e); closeMenu(); }}
          className="grid h-8 w-8 place-items-center rounded-md text-base transition-colors duration-150 hover:bg-muted"
        >
          {e}
        </button>
      ))}
    </div>
  );
}

/**
 * The ⌘↵ hint and the actions under a rich editor – the same row for the
 * composer at the bottom of the thread and for an inline comment edit, which
 * only adds a way out.
 */
function ComposerActions({ submitLabel, canSubmit, onSubmit, onCancel }: {
  submitLabel: string; canSubmit: boolean; onSubmit: () => void; onCancel?: () => void;
}) {
  const t = useT();
  return (
    <div className="mt-2 flex items-center justify-end gap-2.5">
      <span className="flex items-center gap-1 text-[11px] text-faint">
        <Kbd>⌘</Kbd><Kbd>↵</Kbd>
      </span>
      {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>}
      <Button size="sm" disabled={!canSubmit} onClick={onSubmit}>{submitLabel}</Button>
    </div>
  );
}

/**
 * Who may rewrite a comment – the rule the API enforces: its author edits it as
 * a project member, anyone else needs project admin. Resolved here so the
 * pencil never shows on a comment the server would refuse to save.
 */
function canEditComment(comment: TaskComment, role: ProjectRole, myId?: string): boolean {
  if (role === 'admin') return true;
  return role === 'member' && !!myId && comment.authorId === myId;
}

/**
 * One comment card: body, reactions, and – for whoever may rewrite it – an
 * inline editor that swaps the rendered body for the same composer the thread
 * posts with. ⌘↵ saves, Esc leaves the comment as it was.
 */
function CommentCard({ taskId, comment, users, authorName, canEdit }: {
  taskId: string; comment: TaskComment; users: UserLite[]; authorName: string; canEdit: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  // Non-null only while editing – the draft doubles as the mode flag.
  const [draft, setDraft] = useState<unknown>(null);
  const editing = draft !== null;

  const save = useMutation({
    mutationFn: (body: unknown) => api.patch(`/comments/${comment.id}`, { body }),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ['task', taskId] });
    },
    onError: (e: Error) => toast.error(e instanceof ApiError ? e.message : t('task.editCommentFailed')),
  });

  const canSave = editing && docHasText(draft) && !save.isPending;
  const submit = () => { if (canSave) save.mutate(draft); };

  return (
    <div className="group/comment min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 transition-colors duration-150 hover:border-border-strong">
      <p className="mb-1 flex items-baseline gap-2">
        <span className="text-[13px] font-medium">{authorName}</span>
        <span className="text-[11px] text-faint">{fmtRelative(comment.createdAt)}</span>
        {comment.editedAt && (
          <span className="text-[11px] text-faint" title={fmtRelative(comment.editedAt)}>
            ({t('task.commentEdited')})
          </span>
        )}
        {canEdit && !editing && (
          <IconButton
            size="sm"
            aria-label={t('task.editComment')}
            title={t('task.editComment')}
            onClick={() => setDraft(comment.body ?? EMPTY_DOC)}
            className="ml-auto self-start text-faint opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/comment:opacity-100"
          >
            <Pencil size={12} />
          </IconButton>
        )}
      </p>

      {editing ? (
        <div onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDraft(null); } }}>
          <RichEditor
            value={draft}
            onChange={setDraft}
            placeholder={t('tasks.writeComment')}
            compact
            onSubmit={submit}
          />
          <ComposerActions
            submitLabel={t('common.save')}
            canSubmit={canSave}
            onSubmit={submit}
            onCancel={() => setDraft(null)}
          />
        </div>
      ) : (
        <>
          <RichBody doc={comment.body} className="text-[13px]" />
          <ReactionBar taskId={taskId} comment={comment} users={users} />
        </>
      )}
    </div>
  );
}

export function ActivityFeed({ taskId, comments, users, projectRole }: {
  taskId: string; comments: TaskComment[]; users: UserLite[]; projectRole: ProjectRole;
}) {
  const t = useT();
  const me = useMe();
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
              <Avatar
                name={item.comment.authorName ?? nameOf(item.comment.authorId)}
                src={users.find((u) => u.id === item.comment.authorId)?.avatar}
                agent={users.find((u) => u.id === item.comment.authorId)?.actorType === 'agent'}
                size={22}
                className="mt-0.5"
              />
              <CommentCard
                taskId={taskId}
                comment={item.comment}
                users={users}
                authorName={item.comment.authorName ?? nameOf(item.comment.authorId)}
                canEdit={canEditComment(item.comment, projectRole, me.user?.id)}
              />
            </div>
          ) : (
            <div
              key={`a-${item.entry.id}`}
              className="row-enter flex items-center gap-2.5 py-1 pl-[3px]"
              style={{ ['--i' as string]: Math.min(i, 10) }}
            >
              {(() => {
                const actor = item.entry.actorId ? users.find((u) => u.id === item.entry.actorId) : undefined;
                return actor
                  ? <Avatar name={actor.name} src={actor.avatar} size={16} agent={actor.actorType === 'agent'} className="shrink-0" />
                  : <span className="mx-1 h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong" />;
              })()}
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
        <ComposerActions
          submitLabel={t('tasks.comment')}
          canSubmit={canSend && !addComment.isPending}
          onSubmit={submit}
        />
      </div>
    </section>
  );
}
