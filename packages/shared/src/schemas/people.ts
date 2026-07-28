import { z } from 'zod';
import { idSchema, customFieldsSchema } from './common';
import { EMPLOYMENT_TYPES, EMPLOYEE_STATUSES, JOB_OPENING_STATUSES, COMP_TYPES } from '../constants';

export const departmentInputSchema = z.object({
  name: z.string().min(1),
  parentId: idSchema.nullable().optional(),
});

export const positionInputSchema = z.object({ title: z.string().min(1) });

export const employeeInputSchema = z.object({
  userId: idSchema.nullable().optional(),
  firstName: z.string().min(1),
  lastName: z.string().default(''),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  positionId: idSchema.nullable().optional(),
  departmentId: idSchema.nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  managerId: idSchema.nullable().optional(),
  joinDate: z.string().nullable().optional(),
  probationEnd: z.string().nullable().optional(),
  status: z.enum(EMPLOYEE_STATUSES).default('active'),
  emergencyContact: z.record(z.string(), z.unknown()).nullable().optional(),
  sensitive: z.record(z.string(), z.unknown()).nullable().optional(),
  customFields: customFieldsSchema.optional(),
});
export const employeeUpdateSchema = employeeInputSchema.partial().extend({ version: z.number().int().optional() });

export const employeeLifecycleSchema = z.object({
  action: z.enum(['onboard', 'exit', 'set_leave', 'reactivate']),
  exitDate: z.string().nullable().optional(),
});

export const leaveTypeInputSchema = z.object({
  name: z.string().min(1),
  isPaid: z.boolean().default(true),
  needsApproval: z.boolean().default(true),
  affectsBalance: z.boolean().default(true),
  allowHalfDay: z.boolean().default(false),
  annualQuota: z.number().min(0).default(0),
  carryForwardLimit: z.number().min(0).default(0),
  carryForwardExpiry: z.string().nullable().optional(),
});

export const leaveRequestInputSchema = z.object({
  /** Omitted = the requester themselves (PRD §12.2 self-service). */
  employeeId: idSchema.optional(),
  leaveTypeId: idSchema,
  fromDate: z.string(),
  toDate: z.string(),
  halfDay: z.boolean().default(false),
  reason: z.string().default(''),
  attachmentId: idSchema.nullable().optional(),
});

export const leaveDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().default(''),
});

export const holidayCalendarInputSchema = z.object({ name: z.string().min(1) });
export const holidayInputSchema = z.object({
  calendarId: idSchema,
  date: z.string(),
  name: z.string().min(1),
});

export const jobOpeningInputSchema = z.object({
  title: z.string().min(1),
  departmentId: idSchema.nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).default('full_time'),
  description: z.string().default(''),
  status: z.enum(JOB_OPENING_STATUSES).default('draft'),
  positionsCount: z.number().int().min(1).default(1),
  hiringManagerId: idSchema.nullable().optional(),
  salaryRange: z.record(z.string(), z.unknown()).nullable().optional(),
  publicEnabled: z.boolean().default(false),
});

export const applicantInputSchema = z.object({
  jobOpeningId: idSchema,
  name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().nullable().optional(),
  resumeAttachmentId: idSchema.nullable().optional(),
  coverText: z.string().default(''),
  stageId: idSchema.optional(),
  customFields: customFieldsSchema.optional(),
});

export const applicantMoveSchema = z.object({
  stageId: idSchema,
  rejectedReason: z.string().optional(),
});

export const applicantStageInputSchema = z.object({
  name: z.string().min(1),
  position: z.number().default(0),
  isHired: z.boolean().default(false),
  isRejected: z.boolean().default(false),
});

export const interviewInputSchema = z.object({
  applicantId: idSchema,
  scheduledAt: z.string(),
  type: z.string().default('screening'),
  interviewers: z.array(idSchema).default([]),
  scorecard: z.record(z.string(), z.unknown()).nullable().optional(),
  summary: z.string().default(''),
});

export const hireApplicantSchema = z.object({
  joinDate: z.string().nullable().optional(),
  positionId: idSchema.nullable().optional(),
  departmentId: idSchema.nullable().optional(),
  runOnboarding: z.boolean().default(true),
});

export const allocationInputSchema = z.object({
  userId: idSchema,
  projectId: idSchema,
  hoursPerWeek: z.number().min(0),
  fromDate: z.string(),
  toDate: z.string(),
});

export const compensationInputSchema = z.object({
  employeeId: idSchema,
  compType: z.enum(COMP_TYPES),
  amount: z.number().min(0),
  currency: z.string().length(3).default('USD'),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable().optional(),
});

export const overheadSettingsSchema = z.object({
  monthlyBase: z.number().min(0).default(0),
  currency: z.string().length(3).default('USD'),
  workingHoursPerWeek: z.number().min(1).default(40),
  effectiveFrom: z.string(),
});

export const careersApplySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  coverText: z.string().default(''),
  resumeAttachmentId: idSchema.nullable().optional(),
  honeypot: z.string().optional(),
});
