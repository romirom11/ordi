-- Leads are first-class CRM records now. The old "Lead" deal stage created a
-- second, contradictory place for unqualified prospects. Preserve legacy data
-- before removing that stage:
--   * old unqualified deals become reviewable leads with their context intact;
--   * deals already converted from a lead remain deals and move to Qualified.

INSERT INTO "deal_stages" (
  "id", "name", "position", "probability", "is_won", "is_lost"
)
SELECT
  substring(md5('qualified:' || clock_timestamp()::text || random()::text), 1, 26),
  'Qualified',
  COALESCE((
    SELECT min("position")
    FROM "deal_stages"
    WHERE lower(trim("name")) = 'lead'
  ), 0),
  30,
  false,
  false
WHERE EXISTS (
  SELECT 1 FROM "deal_stages" WHERE lower(trim("name")) = 'lead'
)
AND NOT EXISTS (
  SELECT 1
  FROM "deal_stages"
  WHERE lower(trim("name")) <> 'lead'
    AND "is_won" = false
    AND "is_lost" = false
);--> statement-breakpoint

INSERT INTO "leads" (
  "id",
  "company_id",
  "legacy_deal_id",
  "title",
  "status",
  "owner_id",
  "raw_research",
  "created_by",
  "created_at",
  "updated_at"
)
SELECT
  substring(md5('legacy-lead:' || d."id"), 1, 26),
  d."company_id",
  d."id",
  d."title",
  'needs_review',
  d."owner_id",
  jsonb_build_object(
    'legacyDeal',
    jsonb_build_object(
      'amount', d."amount",
      'currency', d."currency",
      'expectedCloseDate', d."expected_close_date",
      'projectId', d."project_id",
      'lostReason', d."lost_reason",
      'customFields', d."custom_fields"
    )
  ),
  d."created_by",
  d."created_at",
  now()
FROM "deals" d
JOIN "deal_stages" s ON s."id" = d."stage_id"
WHERE lower(trim(s."name")) = 'lead'
  AND d."deleted_at" IS NULL
  AND d."source_lead_id" IS NULL
ON CONFLICT ("legacy_deal_id") DO NOTHING;--> statement-breakpoint

UPDATE "notes" n
SET "lead_id" = l."id", "deal_id" = NULL
FROM "leads" l
WHERE l."legacy_deal_id" = n."deal_id";--> statement-breakpoint

UPDATE "attachments" a
SET "entity_type" = 'lead', "entity_id" = l."id"
FROM "leads" l
WHERE l."legacy_deal_id" = a."entity_id"
  AND a."entity_type" = 'deal';--> statement-breakpoint

UPDATE "sales_activities" a
SET "lead_id" = l."id", "deal_id" = NULL
FROM "leads" l
WHERE l."legacy_deal_id" = a."deal_id";--> statement-breakpoint

UPDATE "sales_sequence_enrollments" e
SET "lead_id" = l."id", "deal_id" = NULL
FROM "leads" l
WHERE l."legacy_deal_id" = e."deal_id";--> statement-breakpoint

INSERT INTO "sales_activities" (
  "id",
  "lead_id",
  "company_id",
  "type",
  "status",
  "subject",
  "due_at",
  "owner_id",
  "created_by"
)
SELECT
  substring(md5('legacy-review:' || l."id"), 1, 26),
  l."id",
  l."company_id",
  'review',
  'planned',
  'Review legacy pipeline record',
  now(),
  l."owner_id",
  l."created_by"
FROM "leads" l
WHERE l."legacy_deal_id" IS NOT NULL
  AND l."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "sales_activities" a
    WHERE a."lead_id" = l."id"
      AND a."status" = 'planned'
      AND a."deleted_at" IS NULL
  )
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

INSERT INTO "activity_log" (
  "id", "entity_type", "entity_id", "actor_type", "action", "diff"
)
SELECT
  substring(md5('legacy-audit:' || l."id"), 1, 26),
  'lead',
  l."id",
  'system',
  'created_from_deal',
  jsonb_build_object('legacyDealId', l."legacy_deal_id", 'migration', true)
FROM "leads" l
WHERE l."legacy_deal_id" IS NOT NULL
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint

UPDATE "deals" d
SET "deleted_at" = COALESCE(d."deleted_at", now())
FROM "leads" l
WHERE l."legacy_deal_id" = d."id"
  AND d."deleted_at" IS NULL;--> statement-breakpoint

UPDATE "deals" d
SET "stage_id" = (
  SELECT s."id"
  FROM "deal_stages" s
  WHERE lower(trim(s."name")) <> 'lead'
    AND s."is_won" = false
    AND s."is_lost" = false
  ORDER BY
    CASE WHEN lower(trim(s."name")) = 'qualified' THEN 0 ELSE 1 END,
    s."position",
    s."created_at"
  LIMIT 1
)
WHERE d."stage_id" IN (
  SELECT s."id"
  FROM "deal_stages" s
  WHERE lower(trim(s."name")) = 'lead'
);--> statement-breakpoint

DELETE FROM "deal_stages"
WHERE lower(trim("name")) = 'lead';--> statement-breakpoint

WITH ranked AS (
  SELECT "id", row_number() OVER (ORDER BY "position", "created_at", "id") - 1 AS next_position
  FROM "deal_stages"
)
UPDATE "deal_stages" s
SET "position" = ranked.next_position
FROM ranked
WHERE ranked."id" = s."id";
