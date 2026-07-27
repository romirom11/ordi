/**
 * Audit trail for any record, rendered as human sentences (icon, actor, action,
 * relative date) with a "See all" expander. The audit API is generic
 * (/audit/entity/:type/:id), so every record page gets the same feed – callers
 * only supply how an action reads in their domain.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Activity as ActivityIcon, ChevronDown, Diamond, FileText, MessageSquare, Pencil,
  Sparkles, Trash2, UserMinus, UserPlus, type LucideIcon,
} from 'lucide-react';
import { api } from '../lib/api';
import { Skeleton, fmtRelative } from './ui';
import { useT } from '../lib/i18n';

export interface ActivityUser { id: string; name: string; avatar?: string | null }

interface AuditEntry {
  id: string; action: string; actorId?: string | null; createdAt: string;
  diff?: Record<string, unknown>;
}

const ACTION_ICON: Record<string, LucideIcon> = {
  created: Sparkles,
  updated: Pencil,
  deleted: Trash2,
  member_added: UserPlus,
  member_removed: UserMinus,
  milestone_added: Diamond,
  milestone_completed: Diamond,
  update_posted: MessageSquare,
  note_added: FileText,
  stage_changed: Diamond,
  status_changed: Diamond,
};

const COLLAPSED_COUNT = 6;

export function EntityActivity({ entityType, entityId, users, title, labelFor, queryKey, emptyLabel }: {
  entityType: string;
  entityId: string;
  users: ActivityUser[];
  title: string;
  /** How an audit action reads in this domain, e.g. "updated the project". */
  labelFor: (action: string) => string;
  /** Override when other code invalidates a legacy key for this feed. */
  queryKey?: unknown[];
  emptyLabel: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading } = useQuery<AuditEntry[]>({
    queryKey: queryKey ?? ['audit', entityType, entityId],
    queryFn: () => api.get<{ data: AuditEntry[] }>(`/audit/entity/${entityType}/${entityId}`).then((r) => r.data),
  });

  const nameOf = useMemo(() => {
    const map = new Map(users.map((u) => [u.id, u.name]));
    return (id?: string | null) => (id ? map.get(id) : undefined) ?? t('common.someone');
  }, [users, t]);

  const entries = useMemo(() => {
    const all = data ?? [];
    // Collapse runs of identical (actor, action) pairs into the newest one.
    return all.filter((e, i) => {
      const prev = all[i - 1];
      return !(prev && prev.actorId === e.actorId && prev.action === e.action);
    });
  }, [data]);

  const shown = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);

  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h2>

      {isLoading ? (
        <div className="space-y-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-6" />)}</div>
      ) : entries.length === 0 ? (
        <p className="flex items-center gap-2 text-[13px] text-faint">
          <ActivityIcon size={14} /> {emptyLabel}
        </p>
      ) : (
        <div className="space-y-0.5">
          {shown.map((e, i) => {
            const Icon = ACTION_ICON[e.action] ?? Pencil;
            return (
              <div
                key={e.id}
                className="row-enter flex items-center gap-2.5 py-1"
                style={{ ['--i' as string]: Math.min(i, 10) }}
              >
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                  <Icon size={11} />
                </span>
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  <span className="font-medium text-foreground/80">{nameOf(e.actorId)}</span>{' '}
                  {labelFor(e.action)}
                  <span className="text-faint"> · {fmtRelative(e.createdAt)}</span>
                </p>
              </div>
            );
          })}
          {entries.length > COLLAPSED_COUNT && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              <ChevronDown size={12} className={expanded ? 'rotate-180 transition-transform duration-150' : 'transition-transform duration-150'} />
              {expanded ? t('projects.activity.collapse') : `${t('projects.activity.seeAll')} (${entries.length})`}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
