import { z } from 'zod';
import { idSchema, richTextSchema } from './common';
import { VISIBILITY, SPACE_MEMBER_ROLES, KB_PAGE_TYPES } from '../constants';

export const spaceInputSchema = z.object({
  name: z.string().min(1),
  icon: z.string().default('book'),
  projectId: idSchema.nullable().optional(),
  visibility: z.enum(VISIBILITY).default('workspace'),
  position: z.number().default(0),
});

export const spaceMemberInputSchema = z.object({
  userId: idSchema,
  role: z.enum(SPACE_MEMBER_ROLES).default('editor'),
});

export const pageInputSchema = z.object({
  spaceId: idSchema,
  parentId: idSchema.nullable().optional(),
  title: z.string().min(1),
  type: z.enum(KB_PAGE_TYPES).default('article'),
  body: richTextSchema.optional(),
  icon: z.string().nullable().optional(),
  /** Attachment id of the uploaded document – required when type is 'pdf'. */
  fileId: idSchema.nullable().optional(),
  isTemplate: z.boolean().default(false),
  /** Pages are born visible; a draft is an explicit choice, not a default. */
  published: z.boolean().default(true),
  visibility: z.enum(['public', 'private']).default('public'),
});

export const pageUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  body: richTextSchema.optional(),
  icon: z.string().nullable().optional(),
  fileId: idSchema.nullable().optional(),
  parentId: idSchema.nullable().optional(),
  spaceId: idSchema.optional(),
  published: z.boolean().optional(),
  visibility: z.enum(['public', 'private']).optional(),
  version: z.number().int().optional(),
});

export const pageCommentSchema = z.object({
  body: richTextSchema,
  mentions: z.array(idSchema).default([]),
});

export const pageRestoreSchema = z.object({
  versionNo: z.number().int().min(1),
});
