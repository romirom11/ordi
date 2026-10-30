/**
 * What happened to the text the person typed, said where they typed it rather
 * than in a toast that disappears: saving, saved, not saved (with Retry),
 * restored from an earlier visit, or in conflict with someone else's edit.
 *
 * Two pieces: a quiet one-line status that sits next to the editor, and the
 * conflict banner, which stays until the person picks a version.
 */
import { useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { SyncStatus } from '../lib/draftSync';
import { useT } from '../lib/i18n';
import { Button, cn } from './ui';

export function DraftStatusLine({ status, persisted, error, onRetry, onSave, onDiscard, className, quietWhenSaved, actions = true }: {
  status: SyncStatus;
  persisted: boolean;
  error?: string | null;
  onRetry: () => void;
  /** Explicit save of a restored draft. */
  onSave: () => void;
  onDiscard: () => void;
  className?: string;
  /** Say nothing while everything is saved (pages with an explicit Save). */
  quietWhenSaved?: boolean;
  /** Retry/Save/Discard buttons; off where the surrounding bar has its own. */
  actions?: boolean;
}) {
  const t = useT();
  // The live region stays mounted so each change is announced; the conflict
  // banner speaks for itself.
  const quiet = status === 'conflict' || (status === 'saved' && quietWhenSaved);
  const text = quiet ? ''
    : status === 'saving' ? t('draft.saving', 'Saving…')
      : status === 'saved' ? t('draft.saved', 'Saved')
        : status === 'failed' ? t('draft.failed', 'Not saved')
          : status === 'restored' ? t('draft.restored', 'Unsaved changes restored')
            : t('draft.unsaved', 'Unsaved changes');
  const unsafe = !quiet && status !== 'saved' && status !== 'saving' && !persisted;
  return (
    <div className={cn(quiet ? 'contents' : 'flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs', className)}>
      <span
        role="status"
        className={cn(status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
        title={status === 'failed' && error ? error : undefined}
      >
        {text}
        {unsafe && <span className="text-warning"> · {t('draft.notStored', 'not stored on this device')}</span>}
      </span>
      {actions && status === 'failed' && (
        <Button size="xs" variant="outline" onClick={onRetry}>{t('draft.retry', 'Retry')}</Button>
      )}
      {actions && status === 'restored' && (
        <Button size="xs" variant="outline" onClick={onSave}>{t('common.save')}</Button>
      )}
      {actions && (status === 'failed' || status === 'restored') && (
        <Button size="xs" variant="ghost" onClick={onDiscard}>{t('draft.discard', 'Discard changes')}</Button>
      )}
    </div>
  );
}

export function DraftConflictBanner({ what, onKeepMine, onTakeTheirs, theirs }: {
  /** Already translated: "task", "page". */
  what: string;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  /** Their version, shown on request so the person can compare before choosing. */
  theirs?: ReactNode;
}) {
  const t = useT();
  const [showTheirs, setShowTheirs] = useState(false);
  return (
    <div role="alert" className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-[13px]">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-foreground">
            {t('draft.conflictTitle', 'Someone else changed this {what} while you were editing.').replace('{what}', what)}
          </p>
          <p className="mt-0.5 text-muted-foreground">
            {t('draft.conflictBody', 'Your version is kept here and has not been saved. Choose which one to keep.')}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="xs" onClick={onKeepMine}>{t('draft.keepMine', 'Keep my version')}</Button>
            <Button size="xs" variant="outline" onClick={onTakeTheirs}>{t('draft.takeTheirs', 'Use their version')}</Button>
            {theirs && (
              <Button size="xs" variant="ghost" aria-expanded={showTheirs} onClick={() => setShowTheirs((v) => !v)}>
                {showTheirs ? t('draft.hideTheirs', 'Hide their version') : t('draft.showTheirs', 'Show their version')}
              </Button>
            )}
          </div>
        </div>
      </div>
      {theirs && showTheirs && (
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border bg-background px-3 py-2">{theirs}</div>
      )}
    </div>
  );
}
