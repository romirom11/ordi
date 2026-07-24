-- ordi database triggers, functions & FTS (PRD §3.4, §5.2, §5.3, §8.3, §14.2)
-- Applied by migrate.ts after Drizzle migrations. Idempotent.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ─────────────────────────────────────────────────────────────────────────────
-- Optimistic locking: bump `version` on every UPDATE (PRD §3.4).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ordi_bump_version() RETURNS trigger AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ordi_set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'version'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_bump_version ON %I;', r.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_bump_version BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ordi_bump_version();',
      r.table_name);
  END LOOP;

  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'updated_at'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON %I;', r.table_name);
    EXECUTE format(
      'CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION ordi_set_updated_at();',
      r.table_name);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Per-project task numbering (PRD §8.3): atomic counter, does not touch project rows.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_number_counters (
  project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  last_number integer NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION ordi_assign_task_number() RETURNS trigger AS $$
DECLARE next_num integer;
BEGIN
  IF NEW.number IS NULL OR NEW.number = 0 THEN
    INSERT INTO task_number_counters(project_id, last_number)
    VALUES (NEW.project_id, 1)
    ON CONFLICT (project_id) DO UPDATE
      SET last_number = task_number_counters.last_number + 1
    RETURNING last_number INTO next_num;
    NEW.number := next_num;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_task_number ON tasks;
CREATE TRIGGER trg_assign_task_number BEFORE INSERT ON tasks
  FOR EACH ROW EXECUTE FUNCTION ordi_assign_task_number();

-- ─────────────────────────────────────────────────────────────────────────────
-- Full-text search (PRD §5.2, §14.2): generated tsvector columns + GIN indexes.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE companies ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(domain,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS companies_search_idx ON companies USING gin (search_vector);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(email,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS contacts_search_idx ON contacts USING gin (search_vector);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(key,'') || ' ' || coalesce(description,''))
  ) STORED;
CREATE INDEX IF NOT EXISTS projects_search_idx ON projects USING gin (search_vector);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'')) ||
    jsonb_to_tsvector('simple', coalesce(description, '{}'::jsonb), '["string"]')
  ) STORED;
CREATE INDEX IF NOT EXISTS tasks_search_idx ON tasks USING gin (search_vector);

ALTER TABLE kb_pages ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'')) ||
    jsonb_to_tsvector('simple', coalesce(body, '{}'::jsonb), '["string"]')
  ) STORED;
CREATE INDEX IF NOT EXISTS kb_pages_search_idx ON kb_pages USING gin (search_vector);

-- Trigram indexes on document numbers (PRD §5.2).
CREATE INDEX IF NOT EXISTS invoices_number_trgm_idx ON invoices USING gin (number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS quotes_number_trgm_idx ON quotes USING gin (number gin_trgm_ops);

-- Custom-field GIN indexes (PRD §5.5, level 1): existence/containment filters.
CREATE INDEX IF NOT EXISTS companies_cf_idx ON companies USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS contacts_cf_idx ON contacts USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS deals_cf_idx ON deals USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS projects_cf_idx ON projects USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS tasks_cf_idx ON tasks USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS invoices_cf_idx ON invoices USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS quotes_cf_idx ON quotes USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS employees_cf_idx ON employees USING gin (custom_fields);
CREATE INDEX IF NOT EXISTS applicants_cf_idx ON applicants USING gin (custom_fields);
