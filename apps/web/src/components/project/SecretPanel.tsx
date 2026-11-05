/**
 * One secret, opened from the Resources list. Plain fields (login, URL) show
 * as they are; a secret field shows dots until Show, which reveals it for 30
 * seconds, or Copy, which puts it on the clipboard without ever rendering it.
 * Both are one logged request per field (POST /project-secrets/:id/reveal).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, ExternalLink, Eye, EyeOff, KeyRound, Lock, Pencil, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { openExternal } from '../../lib/desktop';
import { useT } from '../../lib/i18n';
import { isHttpUrl } from '@ordi/shared';
import { Badge, Button, IconButton, Skeleton, Spinner, Tooltip, cn, fmtDate, fmtRelative } from '../ui';
import { ConfirmDialog, SidePanel, toast } from '../overlays';
import type { UserLite } from './pickers';
import { ENV_TONE, daysUntil, isSecretValueType, type SecretFieldMeta, type SecretView } from './secretsShared';

const SHOW_FOR_MS = 30_000;

/** The clipboard can refuse (no focus, no permission): say so instead of failing silently. */
async function toClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

interface TrailEntry { id: string; action: string; actorId: string | null; diff: Record<string, any>; createdAt: string }

export function ExpiryHint({ date, className }: { date: string | null; className?: string }) {
  const t = useT();
  const days = daysUntil(date);
  if (days === null || days > 30) return null;
  const text = days < 0 ? t('secrets.expired') : days === 0 ? t('secrets.expiresToday') : t('secrets.expiresIn').replace('{n}', String(days));
  return <span className={cn('text-xs', days <= 14 ? 'text-destructive' : 'text-warning', className)}>{text}</span>;
}

export function SecretPanel({ secretId, users, onClose, onEdit, onDeleted }: {
  /** null keeps the panel closed. */
  secretId: string | null;
  users: UserLite[];
  onClose: () => void;
  onEdit: (secret: SecretView) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  // Hold on to the last id through the exit animation.
  const [shownId, setShownId] = useState(secretId);
  useEffect(() => { if (secretId) setShownId(secretId); }, [secretId]);
  const id = secretId ?? shownId;

  const secretQ = useQuery<SecretView>({
    queryKey: ['project-secret', id],
    queryFn: () => api.get<SecretView>(`/project-secrets/${id}`),
    enabled: !!secretId,
  });
  const secret = secretQ.data;
  const canSeeTrail = !!secret && (secret.access.reveal || secret.access.write || secret.access.manage);
  const trailQ = useQuery<TrailEntry[]>({
    queryKey: ['project-secret-trail', id],
    queryFn: () => api.get<{ data: TrailEntry[] }>(`/project-secrets/${id}/activity`).then((r) => r.data),
    enabled: !!secretId && canSeeTrail,
  });

  // Values on screen, each with the moment it hides again.
  const [shown, setShown] = useState<Record<string, { value: string; until: number }>>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!Object.keys(shown).length) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      setShown((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v.until > at)));
    }, 1000);
    return () => clearInterval(timer);
  }, [shown]);
  // Nothing revealed survives closing the panel or switching secrets.
  useEffect(() => { setShown({}); }, [secretId]);

  const [confirmDelete, setConfirmDelete] = useState(false);

  const reveal = useMutation({
    mutationFn: (vars: { field: string; purpose: 'reveal' | 'copy' }) =>
      api.post<{ field: string; value: string }>(`/project-secrets/${id}/reveal`, vars),
    onSuccess: async (res, vars) => {
      if (vars.purpose === 'copy') {
        if (await toClipboard(res.value)) toast(t('secrets.copied'));
        else toast.error(t('secrets.copyFailed'));
      } else {
        setShown((s) => ({ ...s, [res.field]: { value: res.value, until: Date.now() + SHOW_FOR_MS } }));
        setNow(Date.now());
      }
      qc.invalidateQueries({ queryKey: ['project-secret-trail', id] });
      qc.invalidateQueries({ queryKey: ['project-secret', id] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.error')),
  });

  const del = useMutation({
    mutationFn: () => api.del(`/project-secrets/${id}`),
    onSuccess: () => { setConfirmDelete(false); toast(t('secrets.deleted')); onDeleted(); onClose(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.error')),
  });

  const userName = (uid: string | null) => users.find((u) => u.id === uid)?.name ?? '—';
  const copyPlain = async (value: string) => {
    if (await toClipboard(value)) toast(t('secrets.copied'));
    else toast.error(t('secrets.copyFailed'));
  };

  const fieldRow = (f: SecretFieldMeta) => {
    const open = shown[f.key];
    const secretField = isSecretValueType(f.type);
    return (
      <div key={f.key} className="space-y-1 py-2.5">
        <div className="text-xs text-muted-foreground">{f.label}</div>
        <div className="flex min-h-7 items-center gap-1.5">
          {!f.hasValue ? (
            <span className="flex-1 text-[13px] text-faint">{t('secrets.noValue')}</span>
          ) : !secretField ? (
            f.type === 'url' && isHttpUrl(f.value!) ? (
              <button type="button" onClick={() => openExternal(f.value!)} className="min-w-0 flex-1 truncate text-left text-[13px] text-primary hover:underline">
                {f.value}
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate text-[13px]">{f.value}</span>
            )
          ) : open ? (
            <span className={cn('min-w-0 flex-1 break-all font-mono text-[13px]', f.type === 'note' && 'whitespace-pre-wrap font-sans')}>
              {open.value}
              <span className="ml-2 text-[11px] tabular-nums text-faint">{Math.min(SHOW_FOR_MS / 1000, Math.max(0, Math.ceil((open.until - now) / 1000)))}s</span>
            </span>
          ) : (
            <span className="flex-1 font-mono text-[13px] tracking-widest text-muted-foreground">
              ••••••••{f.hint && <span className="ml-1 tracking-normal text-faint">…{f.hint}</span>}
            </span>
          )}

          {f.hasValue && !secretField && (
            <Tooltip label={t('secrets.copy')}>
              <IconButton size="sm" aria-label={t('secrets.copy')} onClick={() => copyPlain(f.value!)}><Copy size={13} /></IconButton>
            </Tooltip>
          )}
          {f.hasValue && f.type === 'url' && isHttpUrl(f.value!) && (
            <Tooltip label={f.value!}>
              <IconButton size="sm" aria-label={f.value!} onClick={() => openExternal(f.value!)}><ExternalLink size={13} /></IconButton>
            </Tooltip>
          )}
          {f.hasValue && secretField && secret?.access.reveal && (
            <>
              <Button
                size="xs" variant="ghost"
                disabled={reveal.isPending}
                onClick={() => (open ? setShown((s) => { const next = { ...s }; delete next[f.key]; return next; }) : reveal.mutate({ field: f.key, purpose: 'reveal' }))}
              >
                {open ? <><EyeOff size={13} /> {t('secrets.hide')}</> : <><Eye size={13} /> {t('secrets.reveal')}</>}
              </Button>
              <Button size="xs" variant="ghost" disabled={reveal.isPending} onClick={() => reveal.mutate({ field: f.key, purpose: 'copy' })}>
                <Copy size={13} /> {t('secrets.copy')}
              </Button>
            </>
          )}
        </div>
      </div>
    );
  };

  const trailText = (e: TrailEntry) => {
    const field = (e.diff?.field?.to as string | undefined) ?? '';
    const label = secret?.fields.find((f) => f.key === field)?.label ?? field;
    return t(`secrets.trail.${e.action}`, e.action).replace('{field}', label);
  };

  return (
    <SidePanel open={!!secretId} onClose={onClose} title={secret?.name ?? t('secrets.secret')} icon={<KeyRound size={16} />} width={520}>
      {!secret ? (
        <div className="space-y-3 px-5 pt-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : (
        <div className="space-y-5 px-5 pb-6 pt-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className={ENV_TONE[secret.environment]}>{t(`secrets.env.${secret.environment}`)}</Badge>
            {!secret.audience.some((p) => p.type === 'project') && <Badge><Lock size={11} /> {t('secrets.restricted')}</Badge>}
            {secret.availableToAgents && <Badge><Bot size={11} /> {t('secrets.forAgents')}</Badge>}
            <ExpiryHint date={secret.expiresAt} />
            {secret.expiresAt && (daysUntil(secret.expiresAt) ?? 99) > 30 && (
              <span className="text-xs text-muted-foreground">{t('secrets.expires')}: {fmtDate(secret.expiresAt)}</span>
            )}
          </div>

          {secret.description && <p className="text-[13px] text-muted-foreground">{secret.description}</p>}

          <div className="divide-y divide-border/60 rounded-lg border border-border bg-card px-3">
            {secret.fields.map(fieldRow)}
          </div>
          {!secret.access.reveal && <p className="text-xs text-muted-foreground">{t('secrets.noAccess')}</p>}
          {secret.lastRevealedAt && (
            <p className="text-xs text-faint">
              {t('secrets.lastRevealed').replace('{who}', userName(secret.lastRevealedBy)).replace('{when}', fmtRelative(secret.lastRevealedAt))}
            </p>
          )}

          {canSeeTrail && (
            <section>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('secrets.trail')}</h3>
              {trailQ.isLoading ? <Spinner /> : (
                <ul className="space-y-1">
                  {(trailQ.data ?? []).slice(0, 12).map((e) => (
                    <li key={e.id} className="flex items-baseline gap-1.5 text-xs">
                      <span className="font-medium">{userName(e.actorId)}</span>
                      <span className="text-muted-foreground">{trailText(e)}</span>
                      <span className="ml-auto shrink-0 text-faint">{fmtRelative(e.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {(secret.access.write || secret.access.manage) && (
            <div className="flex justify-between gap-2 border-t border-border pt-4">
              {secret.access.write ? (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={14} /> {t('secrets.delete')}
                </Button>
              ) : <span />}
              <Button size="sm" variant="outline" onClick={() => onEdit(secret)}>
                <Pencil size={14} /> {t('secrets.edit')}
              </Button>
            </div>
          )}

          <ConfirmDialog
            open={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            onConfirm={() => del.mutate()}
            title={t('secrets.delete')}
            body={t('secrets.deleteBody').replace('{name}', secret.name)}
            confirmLabel={t('common.delete')}
            danger
            pending={del.isPending}
          />
        </div>
      )}
    </SidePanel>
  );
}
