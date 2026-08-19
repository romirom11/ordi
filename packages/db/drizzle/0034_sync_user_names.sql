-- One name per person (ORD-19): backfill users.name from the linked employee
-- card, so accounts created with a bare first name pick up the full name the
-- HR card already holds. Going forward the people service keeps the two in
-- step on every card write; this catches everyone linked before that existed.
-- Per user the active card wins over a terminated one, newest breaks ties.
UPDATE users u
SET name = trim(e.first_name || ' ' || e.last_name)
FROM (
  SELECT DISTINCT ON (user_id) user_id, first_name, last_name
  FROM employees
  WHERE user_id IS NOT NULL AND deleted_at IS NULL
  ORDER BY user_id, (status <> 'terminated') DESC, created_at DESC
) e
WHERE u.id = e.user_id
  AND trim(e.first_name || ' ' || e.last_name) <> '';