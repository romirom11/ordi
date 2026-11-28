/**
 * "Waiting on" – a question put to one person on a task (ask_for_input), shown
 * without touching the task's status: a banner on the task page and a small
 * mark on list rows and board cards.
 *
 * The addressee answers by commenting – their first comment closes the
 * question on the server – or with "Mark answered". The asker (or the owner of
 * the asking agent) and the project's lead can withdraw it. Which buttons
 * appear is the server's call (`canMarkAnswered` / `canWithdraw`), so the
 * page never offers an action the API would refuse.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MessageCircleQuestion } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { useUsersLookup } from '../../lib/queries';
import { useT, extendDict } from '../../lib/i18n';
import { Avatar, Button, fmtRelative } from '../ui';
import { toast } from '../overlays';
import type { TaskOpenQuestion } from './types';

extendDict({
  en: {
    'waiting.on': 'Waiting on',
    'waiting.onYou': 'Waiting on you',
    'waiting.askedBy': 'asked by {name}',
    'waiting.answerHint': 'Reply in the comments below – your first comment answers it.',
    'waiting.markAnswered': 'Mark answered',
    'waiting.withdraw': 'Withdraw',
    'waiting.closed': 'The question is closed.',
    'waiting.markFailed': 'Could not update the question',
    'waiting.listMark': 'Waiting on {name}',
  },
  uk: {
    'waiting.on': 'Чекає на',
    'waiting.onYou': 'Чекає на вас',
    'waiting.askedBy': 'питає {name}',
    'waiting.answerHint': 'Відповідайте в коментарях нижче – ваш перший коментар закриє питання.',
    'waiting.markAnswered': 'Позначити як відповідь',
    'waiting.withdraw': 'Відкликати',
    'waiting.closed': 'Питання закрито.',
    'waiting.markFailed': 'Не вдалося оновити питання',
    'waiting.listMark': 'Чекає на {name}',
  },
});

/** Fills `{name}` in a translated string. */
export function withName(template: string, name: string): string {
  return template.replace('{name}', name);
}

export function WaitingOnBanner({ taskId, question }: { taskId: string; question: TaskOpenQuestion }) {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const usersQ = useUsersLookup();
  const addressee = (usersQ.data ?? []).find((u) => u.id === question.addressee.id);
  const mine = question.addressee.id === me.user.id;

  const close = useMutation({
    mutationFn: (how: 'answered' | 'withdraw') => api.post(`/tasks/${taskId}/question/${how}`, {}),
    onSuccess: () => {
      toast(t('waiting.closed'));
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (e: Error) => {
      toast.error(e instanceof ApiError ? e.message : t('waiting.markFailed'));
      qc.invalidateQueries({ queryKey: ['task', taskId] });
    },
  });

  return (
    <section
      aria-label={mine ? t('waiting.onYou') : `${t('waiting.on')} ${question.addressee.name}`}
      className="mb-5 rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <MessageCircleQuestion size={15} className="shrink-0 text-warning" aria-hidden />
        <span className="text-[13px] font-semibold">
          {mine ? t('waiting.onYou') : `${t('waiting.on')}:`}
        </span>
        {!mine && (
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium">
            <Avatar name={question.addressee.name} src={addressee?.avatar} size={16} />
            {question.addressee.name}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          · {withName(t('waiting.askedBy'), question.askedBy.name)} · {fmtRelative(question.askedAt)}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed">{question.question}</p>
      {mine && <p className="mt-1.5 text-xs text-muted-foreground">{t('waiting.answerHint')}</p>}
      {(question.canMarkAnswered || question.canWithdraw) && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {question.canMarkAnswered && (
            <Button size="xs" variant="outline" disabled={close.isPending} onClick={() => close.mutate('answered')}>
              {t('waiting.markAnswered')}
            </Button>
          )}
          {question.canWithdraw && (
            <Button size="xs" variant="ghost" disabled={close.isPending} onClick={() => close.mutate('withdraw')}>
              {t('waiting.withdraw')}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/** The small mark on a list row or board card: whom the task waits on. */
export function WaitingOnMark({ userId, className }: { userId: string; className?: string }) {
  const t = useT();
  const me = useMe();
  const usersQ = useUsersLookup();
  const name = userId === me.user.id
    ? t('waiting.onYou')
    : withName(t('waiting.listMark'), (usersQ.data ?? []).find((u) => u.id === userId)?.name ?? '…');
  return (
    <span title={name} aria-label={name} className={className ?? 'shrink-0 text-warning'}>
      <MessageCircleQuestion size={13} />
    </span>
  );
}
