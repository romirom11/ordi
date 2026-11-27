-- A task's status must be one of its own project's statuses; the API used to
-- store a status id from another project as given. Tasks already sitting in
-- a foreign status move to the matching one of their own project, the way a
-- task move maps statuses: same name, else same category, else the default.
UPDATE "tasks" AS t SET "status_id" = COALESCE(
  (SELECT s."id" FROM "task_statuses" s JOIN "task_statuses" f ON f."id" = t."status_id"
    WHERE s."project_id" = t."project_id" AND lower(trim(s."name")) = lower(trim(f."name")) ORDER BY s."position" LIMIT 1),
  (SELECT s."id" FROM "task_statuses" s JOIN "task_statuses" f ON f."id" = t."status_id"
    WHERE s."project_id" = t."project_id" AND s."category" = f."category" ORDER BY s."position" LIMIT 1),
  (SELECT s."id" FROM "task_statuses" s
    WHERE s."project_id" = t."project_id" ORDER BY s."is_default" DESC, s."position" LIMIT 1),
  t."status_id"
)
WHERE EXISTS (SELECT 1 FROM "task_statuses" f WHERE f."id" = t."status_id" AND f."project_id" <> t."project_id");--> statement-breakpoint
-- A git automation rule pointing at another project's status could only ever
-- have moved tasks into it; the worker now ignores such a rule, so drop it.
DELETE FROM "git_automation_rules" AS r
WHERE NOT EXISTS (SELECT 1 FROM "task_statuses" s WHERE s."id" = r."target_status_id" AND s."project_id" = r."project_id");
