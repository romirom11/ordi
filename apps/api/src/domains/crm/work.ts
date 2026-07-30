import { getDb, sql } from '@ordi/db';
import { localDateKey, safeTimeZone } from '../../lib/timezone';
import { boundedLimit } from './common';

type WorkScope = 'mine' | 'all';
/**
 * Order matters: it is the order a seller works the queue, and the CASE below
 * assigns the first arm that matches.
 *
 * `upcoming` was missing, and its absence turned the queue upside down. A lead
 * with work booked for tomorrow fell through every arm and vanished from the
 * page, while a lead in `waitingReply` - the one state that explicitly needs
 * nothing from you - was always shown. A seller whose week was fully planned saw
 * "no sales work needs attention".
 */
type WorkBucket =
  | 'overdue'
  | 'dueToday'
  | 'upcoming'
  | 'waitingReply'
  | 'nurtureDue'
  | 'noNextAction';

interface WorkQueryRow {
  bucket: WorkBucket;
  bucketTotal: number;
  entityType: 'lead' | 'deal';
  id: string;
  title: string;
  companyId: string;
  companyName: string;
  status: string;
  nurtureUntil: string | null;
  activityId: string | null;
  activityLeadId: string | null;
  activityDealId: string | null;
  activityCompanyId: string | null;
  activityContactId: string | null;
  activityType: string | null;
  activityChannel: string | null;
  activitySubject: string | null;
  activityContext: string | null;
  activityDueAt: Date | null;
  activityOwnerId: string | null;
  activityCreatedAt: Date | null;
  activityVersion: number | null;
}

interface WorkItem {
  entityType: 'lead' | 'deal';
  id: string;
  title: string;
  companyId: string;
  companyName: string;
  status: string;
  nurtureUntil: string | null;
  nextActivity: {
    id: string;
    leadId: string | null;
    dealId: string | null;
    companyId: string;
    contactId: string | null;
    type: string;
    status: 'planned';
    channel: string | null;
    subject: string | null;
    context: string | null;
    dueAt: Date;
    ownerId: string | null;
    createdAt: Date;
    version: number;
  } | null;
}

interface WorkBucketResult {
  rows: WorkItem[];
  total: number;
}

export interface SalesWorkSummary {
  overdue: number;
  dueToday: number;
  upcoming: number;
  waitingReply: number;
  nurtureDue: number;
  noNextAction: number;
  /** Everything the queue holds, context included. */
  total: number;
  /**
   * The part a seller can act on this morning. `waitingReply` and `upcoming`
   * are deliberately excluded: they describe a pipeline that is behaving, and a
   * digest that fires for them would arrive on days with nothing to do.
   */
  actionable: number;
}

export function summarizeSalesWork(
  work: Record<WorkBucket, Pick<WorkBucketResult, 'total'>>,
): SalesWorkSummary {
  const summary = {
    overdue: work.overdue.total,
    dueToday: work.dueToday.total,
    upcoming: work.upcoming.total,
    waitingReply: work.waitingReply.total,
    nurtureDue: work.nurtureDue.total,
    noNextAction: work.noNextAction.total,
  };
  return {
    ...summary,
    total: Object.values(summary).reduce((sum, count) => sum + count, 0),
    actionable: summary.overdue + summary.dueToday + summary.nurtureDue + summary.noNextAction,
  };
}

export interface SalesWorkViewer {
  userId: string;
  timezone: string;
  access: { permissions: Set<string> };
}

/**
 * Bucket counts without the rows.
 *
 * The morning digest and the dashboard tile want six integers, and the full
 * query pays for a `row_number()` over every open lead and deal to produce them
 * – which the `upcoming` bucket made materially wider, since a healthy pipeline
 * is mostly work that is merely booked. Aggregating skips the window functions
 * and the 21-column projection entirely.
 */
export async function salesWorkCounts(
  actor: SalesWorkViewer,
  params: { scope?: WorkScope; now?: Date } = {},
): Promise<SalesWorkSummary> {
  const totals = await queryWork(actor, params, null);
  return summarizeSalesWork(totals as Record<WorkBucket, { total: number }>);
}

export async function salesWork(
  actor: SalesWorkViewer,
  params: { scope?: WorkScope; limit?: number; now?: Date } = {},
) {
  return queryWork(actor, params, boundedLimit(params.limit, 50, 200));
}

/** `limit === null` returns bucket totals only; otherwise rows up to the limit. */
async function queryWork(
  actor: SalesWorkViewer,
  params: { scope?: WorkScope; now?: Date },
  limit: number | null,
) {
  const { db } = getDb();
  const canReadDeals = actor.access.permissions.has('deals.read');
  const mineOnly = params.scope !== 'all';
  const work: Record<WorkBucket, WorkBucketResult> = {
    overdue: { rows: [], total: 0 },
    dueToday: { rows: [], total: 0 },
    upcoming: { rows: [], total: 0 },
    waitingReply: { rows: [], total: 0 },
    nurtureDue: { rows: [], total: 0 },
    noNextAction: { rows: [], total: 0 },
  };
  const timeZone = safeTimeZone(actor.timezone);
  const today = localDateKey(params.now ?? new Date(), timeZone);
  const rows = await db.execute(sql`
    with work_clock as (
      select
        ${today}::date as today,
        (${today}::date::timestamp at time zone ${timeZone}) as day_start,
        (((${today}::date + 1)::timestamp) at time zone ${timeZone}) as next_day_start
    ),
    lead_work as (
      select
        'lead'::text as entity_type,
        l.id,
        l.title,
        l.company_id,
        c.name as company_name,
        l.status as entity_status,
        l.nurture_until,
        a.id as activity_id,
        a.lead_id as activity_lead_id,
        a.deal_id as activity_deal_id,
        a.company_id as activity_company_id,
        a.contact_id as activity_contact_id,
        a.type as activity_type,
        a.channel as activity_channel,
        a.subject as activity_subject,
        a.context as activity_context,
        a.due_at as activity_due_at,
        a.owner_id as activity_owner_id,
        a.created_at as activity_created_at,
        a.version as activity_version,
        case
          when a.due_at < work_clock.day_start then 'overdue'
          when a.due_at < work_clock.next_day_start then 'dueToday'
          when l.status = 'nurture' then
            case when l.nurture_until is not null and l.nurture_until <= work_clock.today::text then 'nurtureDue' end
          when l.status = 'waiting_reply' then 'waitingReply'
          when a.id is not null then 'upcoming'
          else 'noNextAction'
        end as bucket
      from leads l
      join companies c on c.id = l.company_id and c.deleted_at is null
      cross join work_clock
      left join lateral (
        select sa.id, sa.lead_id, sa.deal_id, sa.company_id, sa.contact_id, sa.type,
               sa.channel, sa.subject, sa.context, sa.due_at, sa.owner_id, sa.created_at, sa.version
        from sales_activities sa
        where sa.lead_id = l.id and sa.status = 'planned' and sa.deleted_at is null
        order by sa.due_at, sa.created_at
        limit 1
      ) a on true
      where l.deleted_at is null
        and l.status not in ('converted', 'disqualified', 'no_response')
        and ${mineOnly
          ? sql`(coalesce(a.owner_id, l.owner_id) = ${actor.userId} or coalesce(a.owner_id, l.owner_id) is null)`
          : sql`true`}
    ),
    deal_work as (
      select
        'deal'::text as entity_type,
        d.id,
        d.title,
        d.company_id,
        c.name as company_name,
        ds.name as entity_status,
        null::text as nurture_until,
        a.id as activity_id,
        a.lead_id as activity_lead_id,
        a.deal_id as activity_deal_id,
        a.company_id as activity_company_id,
        a.contact_id as activity_contact_id,
        a.type as activity_type,
        a.channel as activity_channel,
        a.subject as activity_subject,
        a.context as activity_context,
        a.due_at as activity_due_at,
        a.owner_id as activity_owner_id,
        a.created_at as activity_created_at,
        a.version as activity_version,
        case
          when a.due_at < work_clock.day_start then 'overdue'
          when a.due_at < work_clock.next_day_start then 'dueToday'
          when a.id is not null then 'upcoming'
          else 'noNextAction'
        end as bucket
      from deals d
      join companies c on c.id = d.company_id and c.deleted_at is null
      join deal_stages ds on ds.id = d.stage_id and ds.is_won = false and ds.is_lost = false
      cross join work_clock
      left join lateral (
        select sa.id, sa.lead_id, sa.deal_id, sa.company_id, sa.contact_id, sa.type,
               sa.channel, sa.subject, sa.context, sa.due_at, sa.owner_id, sa.created_at, sa.version
        from sales_activities sa
        where sa.deal_id = d.id and sa.status = 'planned' and sa.deleted_at is null
        order by sa.due_at, sa.created_at
        limit 1
      ) a on true
      where d.deleted_at is null
        and ${canReadDeals ? sql`true` : sql`false`}
        and ${mineOnly
          ? sql`(coalesce(a.owner_id, d.owner_id) = ${actor.userId} or coalesce(a.owner_id, d.owner_id) is null)`
          : sql`true`}
    ),
    combined as (
      select * from lead_work
      union all
      select * from deal_work
    )
    ${limit === null ? sql`
      select bucket, count(*)::int as "bucketTotal"
      from combined
      where bucket is not null
      group by bucket
    ` : sql`
    , ranked as (
      select combined.*,
             row_number() over (
               partition by bucket
               order by activity_due_at nulls last, nurture_until nulls last, id
             ) as queue_rank,
             count(*) over (partition by bucket)::int as bucket_total
      from combined
      where bucket is not null
    )
    select
      bucket,
      bucket_total as "bucketTotal",
      entity_type as "entityType",
      id,
      title,
      company_id as "companyId",
      company_name as "companyName",
      entity_status as status,
      nurture_until as "nurtureUntil",
      activity_id as "activityId",
      activity_lead_id as "activityLeadId",
      activity_deal_id as "activityDealId",
      activity_company_id as "activityCompanyId",
      activity_contact_id as "activityContactId",
      activity_type as "activityType",
      activity_channel as "activityChannel",
      activity_subject as "activitySubject",
      activity_context as "activityContext",
      activity_due_at as "activityDueAt",
      activity_owner_id as "activityOwnerId",
      activity_created_at as "activityCreatedAt",
      activity_version as "activityVersion"
    from ranked
    where queue_rank <= ${limit}
    order by bucket, queue_rank
    `}
  `) as unknown as WorkQueryRow[];
  for (const row of rows) {
    if (!(row.bucket in work)) continue;
    work[row.bucket].total = Number(row.bucketTotal);
    if (limit === null) continue;
    const item: WorkItem = {
      entityType: row.entityType,
      id: row.id,
      title: row.title,
      companyId: row.companyId,
      companyName: row.companyName,
      status: row.status,
      nurtureUntil: row.nurtureUntil,
      nextActivity: row.activityId ? {
        id: row.activityId,
        leadId: row.activityLeadId,
        dealId: row.activityDealId,
        companyId: row.activityCompanyId!,
        contactId: row.activityContactId,
        type: row.activityType!,
        status: 'planned',
        channel: row.activityChannel,
        subject: row.activitySubject,
        context: row.activityContext,
        dueAt: row.activityDueAt!,
        ownerId: row.activityOwnerId,
        createdAt: row.activityCreatedAt!,
        version: row.activityVersion!,
      } : null,
    };
    work[row.bucket].rows.push(item);
  }
  return work;
}
