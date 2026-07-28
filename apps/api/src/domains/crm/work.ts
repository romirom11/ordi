import { getDb, sql } from '@ordi/db';
import type { Actor } from '../../context';

type WorkScope = 'mine' | 'all';
type WorkBucket = 'overdue' | 'dueToday' | 'waitingReply' | 'nurtureDue' | 'noNextAction';

interface WorkQueryRow {
  bucket: WorkBucket;
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

function boundedLimit(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value!), 200)) : 50;
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function salesWork(
  actor: Actor,
  params: { scope?: WorkScope; limit?: number } = {},
) {
  const { db } = getDb();
  const canReadDeals = actor.access.permissions.has('deals.read');
  const limit = boundedLimit(params.limit);
  const mineOnly = params.scope !== 'all';
  const work: Record<WorkBucket, WorkItem[]> = {
    overdue: [],
    dueToday: [],
    waitingReply: [],
    nurtureDue: [],
    noNextAction: [],
  };
  const now = new Date();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);
  const endToday = new Date(now);
  endToday.setHours(23, 59, 59, 999);
  const startTodayIso = startToday.toISOString();
  const endTodayIso = endToday.toISOString();
  const today = localDateKey(endToday);
  const rows = await db.execute(sql`
    with lead_work as (
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
          when l.status = 'nurture' then
            case when l.nurture_until is not null and l.nurture_until <= ${today} then 'nurtureDue' end
          when a.due_at < ${startTodayIso}::timestamptz then 'overdue'
          when a.due_at <= ${endTodayIso}::timestamptz then 'dueToday'
          when l.status = 'waiting_reply' then 'waitingReply'
          when a.id is null then 'noNextAction'
        end as bucket
      from leads l
      join companies c on c.id = l.company_id and c.deleted_at is null
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
        and ${mineOnly ? sql`coalesce(a.owner_id, l.owner_id) = ${actor.userId}` : sql`true`}
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
          when a.due_at < ${startTodayIso}::timestamptz then 'overdue'
          when a.due_at <= ${endTodayIso}::timestamptz then 'dueToday'
          when a.id is null then 'noNextAction'
        end as bucket
      from deals d
      join companies c on c.id = d.company_id and c.deleted_at is null
      join deal_stages ds on ds.id = d.stage_id and ds.is_won = false and ds.is_lost = false
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
        and ${mineOnly ? sql`coalesce(a.owner_id, d.owner_id) = ${actor.userId}` : sql`true`}
    ),
    ranked as (
      select combined.*,
             row_number() over (
               partition by bucket
               order by activity_due_at nulls last, nurture_until nulls last, id
             ) as queue_rank
      from (
        select * from lead_work
        union all
        select * from deal_work
      ) combined
      where bucket is not null
    )
    select
      bucket,
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
  `) as unknown as WorkQueryRow[];
  for (const row of rows) {
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
    if (row.bucket in work) work[row.bucket].push(item);
  }
  return work;
}
