/**
 * The deal row, shared by every list that shows deals inside another record:
 * the client card and the project overview. Title, stage, close date, amount
 * and owner – enough to tell at a glance which deal has gone stale without
 * opening it.
 */
import { Link } from '../../lib/router';
import { Avatar, Badge, Tooltip, cn, fmtDate, fmtMoney } from '../ui';
import type { Deal, Stage, UserLite } from './shared';

export function DealRows({ deals, stages, users, companyNames }: {
  deals: Deal[];
  stages: Stage[];
  users: UserLite[];
  /**
   * Client name per company id. Supply it where the client is not implied by
   * the surrounding record – a product project collects leads from many
   * companies. Omitted when the viewer lacks `crm.read`, so the column is a
   * permission boundary, not decoration.
   */
  companyNames?: Map<string, string>;
}) {
  const stageMap = new Map(stages.map((s) => [s.id, s]));
  const userMap = new Map(users.map((u) => [u.id, u]));

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {deals.map((d, i) => {
        const stage = d.stageId ? stageMap.get(d.stageId) : undefined;
        const color = stage?.isWon ? '#22c55e' : stage?.isLost ? '#ef4444' : undefined;
        const owner = d.ownerId ? userMap.get(d.ownerId) : undefined;
        const client = companyNames && d.companyId ? companyNames.get(d.companyId) : undefined;
        return (
          <Link
            key={d.id}
            to={`/deals/${d.id}`}
            style={{ ['--i' as string]: Math.min(i, 10) }}
            className={cn('row-enter flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50', i > 0 && 'border-t border-border')}
          >
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{d.title}</span>
            {client && (
              <span className="hidden min-w-0 max-w-[9rem] shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:flex">
                <Avatar name={client} size={16} />
                <span className="truncate">{client}</span>
              </span>
            )}
            {stage && <Badge color={color}>{stage.name}</Badge>}
            <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
              {d.expectedCloseDate ? fmtDate(d.expectedCloseDate) : '–'}
            </span>
            <span className="w-24 shrink-0 text-right text-[13px] font-semibold tabular-nums">
              {d.amount != null ? fmtMoney(d.amount, d.currency ?? 'USD') : '–'}
            </span>
            <span className="w-5 shrink-0">
              {owner
                ? <Tooltip label={owner.name}><Avatar name={owner.name} src={owner.avatar} size={20} /></Tooltip>
                : <span className="grid h-5 w-5 place-items-center rounded-full border border-dashed border-border-strong text-[9px] text-faint">?</span>}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
