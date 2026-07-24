import { useState } from 'react';
import {
  Check, Copy, ExternalLink, GitBranch, GitCommit, GitPullRequest,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Badge, Spinner, cn } from '../ui';
import { toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'task.git': 'Git',
    'task.copyBranch': 'Copy branch name',
    'task.branchCopied': 'Branch name copied',
    'task.state.open': 'Open',
    'task.state.merged': 'Merged',
    'task.state.closed': 'Closed',
  },
  uk: {
    'task.git': 'Git',
    'task.copyBranch': 'Копіювати назву гілки',
    'task.branchCopied': 'Назву гілки скопійовано',
    'task.state.open': 'Відкрито',
    'task.state.merged': 'Змерджено',
    'task.state.closed': 'Закрито',
  },
});

export interface GitLink {
  id: string;
  type: string; // branch | commit | pr | mr
  externalRef: string;
  title?: string | null;
  url?: string | null;
  state?: string | null; // open | merged | closed
}

function LinkIcon({ type, className }: { type: string; className?: string }) {
  if (type === 'pr' || type === 'mr') return <GitPullRequest size={14} className={className} />;
  if (type === 'commit') return <GitCommit size={14} className={className} />;
  return <GitBranch size={14} className={className} />;
}

function StateBadge({ state }: { state: string }) {
  const t = useT();
  const map: Record<string, { cls: string; key: string }> = {
    open: { cls: 'text-primary', key: 'task.state.open' },
    merged: { cls: 'text-success', key: 'task.state.merged' },
    closed: { cls: 'text-faint', key: 'task.state.closed' },
  };
  const meta = map[state];
  if (!meta) return <Badge className="bg-muted text-[10px] capitalize text-muted-foreground">{state}</Badge>;
  return <Badge className={cn('bg-muted text-[10px]', meta.cls)}>{t(meta.key)}</Badge>;
}

/**
 * Git block for the task sidebar: copy the conventional branch name and view
 * any linked branches / PRs. Shown when the project has bound repos or the task
 * already has git links; the copy action is always available.
 */
export function GitBlock({ taskId, links, showLinks }: { taskId: string; links: GitLink[]; showLinks?: boolean }) {
  const t = useT();
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyBranch = async () => {
    setCopying(true);
    try {
      const { branch } = await api.get<{ branch: string }>(`/tasks/${taskId}/branch-name`);
      await navigator.clipboard.writeText(branch);
      setCopied(true);
      toast(t('task.branchCopied'));
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('common.error'));
    } finally {
      setCopying(false);
    }
  };

  const hasLinks = links.length > 0;
  if (!hasLinks && !showLinks) {
    // Minimal always-available copy row.
    return (
      <button
        onClick={copyBranch}
        disabled={copying}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
      >
        {copying ? <Spinner className="h-3.5 w-3.5" /> : copied ? <Check size={14} className="text-success" /> : <GitBranch size={14} />}
        <span className="truncate">{t('task.copyBranch')}</span>
      </button>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between px-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('task.git')}</span>
        <button
          onClick={copyBranch}
          disabled={copying}
          className="flex items-center gap-1 rounded px-1 py-0.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          {copying ? <Spinner className="h-3 w-3" /> : copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
          {t('task.copyBranch')}
        </button>
      </div>
      {hasLinks && (
        <div className="space-y-0.5">
          {links.map((l) => {
            const label = l.title || l.externalRef;
            const inner = (
              <>
                <LinkIcon type={l.type} className="shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-[13px]">{label}</span>
                {l.state && <StateBadge state={l.state} />}
                {l.url && <ExternalLink size={12} className="shrink-0 text-faint" />}
              </>
            );
            const cls = 'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors duration-150 hover:bg-muted';
            return l.url ? (
              <a key={l.id} href={l.url} target="_blank" rel="noreferrer noopener" className={cls}>{inner}</a>
            ) : (
              <div key={l.id} className={cls}>{inner}</div>
            );
          })}
        </div>
      )}
    </div>
  );
}
