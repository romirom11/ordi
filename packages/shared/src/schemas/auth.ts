import { z } from 'zod';
import { idSchema } from './common';
import { PERMISSIONS } from '../permissions';
import { DATE_FORMATS, type DateFormat } from '../constants';
import { MY_AGENT_TOKEN_DEFAULT_DAYS } from './agents';

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

export const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
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
  dateFormat: z.enum(DATE_FORMATS).optional(),
  avatar: z.string().nullable().optional(),
  emailNotificationPrefs: z.record(z.string(), z.boolean()).optional(),
});

export const createApiTokenSchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.enum(PERMISSIONS)),
  readOnly: z.boolean().default(false),
});

/**
 * A token for an MCP client that cannot sign in through the browser, acting
 * as the person: named after the client, with every permission they hold and
 * the same lifetimes a token for their own agent offers.
 */
export const createClientTokenSchema = z.object({
  client: z.string().trim().min(1).max(40),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(MY_AGENT_TOKEN_DEFAULT_DAYS),
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
    dateFormat: DateFormat;
    emailNotificationPrefs: Record<string, boolean>;
    roleId: string;
    roleName: string;
    isActive: boolean;
  };
  permissions: string[];
  projectMemberships: { projectId: string; role: string; canWriteTasks: boolean }[];
  spaceMemberships: { spaceId: string; role: string }[];
  actorType: 'user' | 'agent';
  /** The linked HR card, when one exists – where the person's identity lives (ORD-19). */
  employee?: { id: string } | null;
}
