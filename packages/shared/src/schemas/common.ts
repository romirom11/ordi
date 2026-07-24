import { z } from 'zod';
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_ENTITIES,
} from '../constants';

/** ULID-ish id (26 chars, Crockford base32). Loosened to be robust. */
export const idSchema = z.string().min(1).max(40);

export const paginationSchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type Pagination = z.infer<typeof paginationSchema>;

export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

/** Optimistic-locking envelope: mutations carry the known version. */
export const versionedSchema = z.object({
  version: z.number().int().min(1),
});

export const customFieldsSchema = z.record(z.string(), z.unknown()).default({});

/** Structured custom-field filter (PRD §5.5): never raw SQL. */
export const customFieldFilterSchema = z.object({
  field_key: z.string(),
  op: z.enum(['eq', 'gt', 'lt', 'between', 'in', 'contains', 'before', 'after']),
  value: z.unknown(),
});
export type CustomFieldFilter = z.infer<typeof customFieldFilterSchema>;

export const customFieldDefinitionSchema = z.object({
  entityType: z.enum(CUSTOM_FIELD_ENTITIES),
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase snake_case'),
  label: z.string().min(1),
  type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  required: z.boolean().default(false),
  position: z.number().default(0),
  showInList: z.boolean().default(false),
  isSortable: z.boolean().default(false),
  indexed: z.boolean().default(false),
});
export type CustomFieldDefinitionInput = z.infer<typeof customFieldDefinitionSchema>;

/** Tiptap rich-text document is stored as JSON. */
export const richTextSchema = z.any();

export const attachmentRefSchema = z.object({
  id: idSchema,
  filename: z.string(),
  size: z.number(),
  mime: z.string(),
  url: z.string().optional(),
});

export const moneySchema = z.object({
  amount: z.number(),
  currency: z.string().length(3),
});

/** Common list query params shared by most list endpoints. */
export const listQuerySchema = paginationSchema.extend({
  q: z.string().optional(),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional(),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
