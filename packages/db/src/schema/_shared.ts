/** Shared column helpers & naming conventions (PRD §5.2). */
import { text, timestamp, integer, numeric, jsonb } from 'drizzle-orm/pg-core';
import { ulid } from 'ulid';

/** ULID primary key. */
export const pk = () => text('id').primaryKey().$defaultFn(() => ulid());

/** Standard audit timestamps present on every table. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** created_by is nullable for system-generated rows. */
export const createdBy = () => text('created_by');

/** Optimistic-locking version — incremented by a DB trigger on every UPDATE (PRD §3.4, §5.2). */
export const version = () => integer('version').notNull().default(1);

/** Soft delete marker (PRD §5.2). */
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true });

/** custom_fields JSONB (PRD §5.5). */
export const customFields = () => jsonb('custom_fields').notNull().default({});

export const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
export const position = (name = 'position') => numeric(name).notNull().default('1000');
