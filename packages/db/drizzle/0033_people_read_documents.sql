-- Employee documents get their own read permission. Existing installs keep
-- today's visibility: every role that could read HR (people.read) keeps seeing
-- documents until an admin narrows it in the role matrix.
INSERT INTO role_permissions (role_id, permission)
SELECT role_id, 'people.read_documents' FROM role_permissions
WHERE permission = 'people.read'
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- Claim existing HR-document attachments for their employee: entity-less
-- attachments hand out their signed URL to any authenticated user, an
-- employee-bound one answers to people.read_documents.
UPDATE attachments a
SET entity_type = 'employee', entity_id = ed.employee_id
FROM employee_documents ed
WHERE ed.attachment_id = a.id AND a.entity_type IS NULL;
