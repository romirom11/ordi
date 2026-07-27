-- Repository bindings must store a `git_repositories.id`: webhook deliveries
-- resolve projects through that id, and the project page reads the repository
-- name from that row. The repo picker lists repositories straight from the
-- provider though, and used to bind the provider's own id verbatim – such a
-- binding linked nothing and rendered as a bare number. Point those rows at the
-- registered repository instead.

-- Rows whose repaired target is already bound to the same project would collide
-- on the primary key – they are pure duplicates, so drop them first.
DELETE FROM "project_repositories" pr
USING "git_repositories" gr
WHERE pr."repository_id" = gr."external_id"
  AND NOT EXISTS (SELECT 1 FROM "git_repositories" x WHERE x."id" = pr."repository_id")
  AND EXISTS (
    SELECT 1 FROM "project_repositories" p2
    WHERE p2."project_id" = pr."project_id" AND p2."repository_id" = gr."id"
  );--> statement-breakpoint

UPDATE "project_repositories" pr
SET "repository_id" = (
  SELECT gr."id" FROM "git_repositories" gr
  WHERE gr."external_id" = pr."repository_id"
  ORDER BY gr."created_at"
  LIMIT 1
)
WHERE NOT EXISTS (SELECT 1 FROM "git_repositories" x WHERE x."id" = pr."repository_id")
  AND EXISTS (SELECT 1 FROM "git_repositories" y WHERE y."external_id" = pr."repository_id");
