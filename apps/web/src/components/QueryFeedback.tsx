import { useT } from '../lib/i18n';
import { Button } from './ui';

/** Failed data is unknown, not an empty collection or a business zero. */
export function QueryFeedback({ stale = false, pending, onRetry }: {
  stale?: boolean;
  pending: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div role={stale ? 'status' : 'alert'} className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-border p-3 text-sm">
      <span>{stale ? t('common.dataStale', 'Could not refresh. Showing the last available data.') : t('common.loadFailed', 'Could not load the data.')}</span>
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onRetry}>{t('common.retry', 'Retry')}</Button>
    </div>
  );
}
