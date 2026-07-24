import { z } from 'zod';
import { idSchema } from './common';
import { PERMISSIONS } from '../permissions';

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

export const acceptInviteSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1),
  password: z.string().min(8),
});

export const inviteUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  roleId: idSchema,
});

export const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  timezone: z.string().optional(),
  locale: z.enum(['uk', 'en']).optional(),
  avatar: z.string().nullable().optional(),
  emailNotificationPrefs: z.record(z.string(), z.boolean()).optional(),
});

export const createApiTokenSchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.enum(PERMISSIONS)),
  readOnly: z.boolean().default(false),
});

export const changeRoleSchema = z.object({
  roleId: idSchema,
});

export const roleInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  permissions: z.array(z.enum(PERMISSIONS)),
});

/** Shape of GET /me. */
export interface MeResponse {
  user: {
    id: string;
    email: string;
    name: string;
    avatar: string | null;
    timezone: string;
    locale: 'uk' | 'en';
    roleId: string;
    roleName: string;
    isActive: boolean;
  };
  permissions: string[];
  projectMemberships: { projectId: string; role: string; canWriteTasks: boolean }[];
  spaceMemberships: { spaceId: string; role: string }[];
  actorType: 'user' | 'agent';
}
