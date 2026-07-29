# ordi API – Domain module authoring guide

You are implementing ONE domain module inside `apps/api/src/domains/<domain>/`.
**Only create files inside your assigned domain folder.** Never edit shared files,
`app.ts`, the db schema, or `@ordi/shared`. Those already import your router by name.

## Read first
- `docs/prd.md` (relevant sections listed in your task)
- `apps/api/src/domains/crm/routes.ts` and `apps/api/src/domains/crm/service.ts` – the reference pattern. Mirror its style exactly.

## Available imports & signatures

### DB (`@ordi/db`)
- `getDb()` → `{ db, sql, close }`. Use `const { db } = getDb();`
- Query builders re-exported: `eq, and, or, ne, gt, gte, lt, lte, inArray, notInArray, isNull, isNotNull, desc, asc, count, sum, like, ilike, sql`, plus type `SQL`.
- `schema.*` – every table. Money/numeric columns are **strings** in Drizzle (`numeric`), so write `String(amount)` on insert/update and `Number(x)` when reading.
- Tables you can use (snake_case in SQL, camelCase in schema objects): see `packages/db/src/schema/*`. Key ones per domain listed in your task.
- Every editable business table has `version` (bumped by DB trigger), `createdAt`, `updatedAt`, `createdBy`, most have `deletedAt` (soft delete) and `customFields`.
- Tasks get their per-project `number` from a DB trigger – insert with `number: 0`.

### Auth / RBAC / context
- `import { requireAuth, currentActor } from '../../core/auth'` – `app.use('*', requireAuth)` then `const actor = currentActor(c)`.
- `import { guard } from '../../core/rbac'` – `guard('finance.read')` as route middleware. Every route needs a `guard(...)` (or is a public route in the `public` domain).
- `actor`: `{ userId, actorType, roleId, roleName, email, name, locale, readOnly, access }`. `actor.access.permissions` is a `Set<string>`. `actor.access.projectMemberships: Map<projectId, 'admin'|'member'|'viewer'>`, `spaceMemberships: Map<spaceId,'editor'|'viewer'>`.

### Resource access
- `import { assertProject, assertSpace, accessibleProjectIds } from '../../core/access'`
  - `await assertProject(actor, projectId, 'viewer'|'member'|'admin')` → throws 404 if no access; returns `{ id, visibility, projectTypeId, companyId }`.
  - `await assertSpace(actor, spaceId, 'viewer'|'editor')` → throws 404; returns `{ id, visibility, projectId }`.
  - `await accessibleProjectIds(actor)` → `string[]` (cached per request).

### Errors (`../../lib/errors`)
- `import { err } from '../../lib/errors'` → `err.validation(msg,details) | err.unauthenticated() | err.forbidden(msg,perm) | err.notFound(msg) | err.conflict(msg,current) | err.domain(msg,details) | err.rateLimited()`.

### Optimistic locking
- `import { assertVersion } from '../../core/locking'` → `assertVersion(entity, body.version, entity)` throws 409 if stale. Then update with `.where(and(eq(id), eq(version, entity.version)))`.

### Activity log (with redaction, mandatory on mutations)
- `import { writeActivity } from '../../core/activity'`
  - `await writeActivity(db, { entityType, entityId, action, before?, after?, actorId: actor.userId, actorType: actor.actorType })`
- `import { recordSensitiveAccess } from '../../core/activity'` – call when reading compensation/sensitive fields.

### Events (outbox)
- `import { emit } from '../../core/events'`
  - `await emit({ type, aggregateType, aggregateId, payload, actorId, actorType })`
- Event `type` values are in `@ordi/shared` EVENT_TYPES; `aggregateType` in AGGREGATE_TYPES. Only emit listed ones.

### Zod schemas (`@ordi/shared`)
- All input schemas already exist (e.g. `taskInputSchema`, `invoiceInputSchema`, `leaveRequestInputSchema`). Parse with `schema.parse(await c.req.json())`. Query params via `c.req.query('x')`.

### Pure calc (`@ordi/shared`) – USE THESE, don't reimplement
- `computeDocumentTotals`, `computePaidState`, `wouldOverpay` (money)
- `hourlyCostRate`, `overheadPerHour`, `compensationAt`, `computeProfitability`, `utilization` (cost)
- `computeAging` (finance), `leaveDays, availableBalance, carryForward, rangesOverlap` (leave)
- `parseTaskRefs, buildBranchName` (git), `positionBetween, appendPosition` (ordering)
- Status transition maps: `INVOICE_TRANSITIONS, QUOTE_TRANSITIONS, LEAVE_TRANSITIONS`.

### Numbering
- `import { nextNumber } from '../../workers/scheduled'` → `await nextNumber('invoice'|'quote')` returns e.g. `INV-2026-0001`.

### Pagination helper
- `import { page } from '../../lib/http'` → `page(rows, limit, (r) => ({ createdAt: r.createdAt }))` (query rows with `.limit(limit+1)`).

### Email / S3 / crypto
- `import { sendEmailNow } from '../../lib/email'`; background mail uses `enqueueEmail` from `workers/email-delivery`; `import { presignUpload, presignDownload } from '../../lib/s3'`; `import { encrypt, decrypt, hmacSha256, generateToken } from '../../lib/crypto'`.

## Rules
1. Export exactly the function name given in your task: e.g. `export function projectsRoutes() { const app = new Hono<AppEnv>(); ... return app; }`.
2. `import type { AppEnv } from '../../context'` and `new Hono<AppEnv>()`.
3. Every non-public route has a `guard('<permission>')`. Reads use `.read`, writes use `.write/.create/...`.
4. Money columns are strings: `String(x)` in, `Number(x)` out.
5. Mutations: write activity + emit events where the PRD lists an event.
6. Soft-delete (`deletedAt`) for business entities; filter `isNull(table.deletedAt)` in reads.
7. Keep it TypeScript-clean (strict mode, `noUncheckedIndexedAccess`). Prefer explicit `any` casts on raw `db.execute(sql\`...\`)` results (`as any[]`).
8. Do NOT start servers or run migrations. Just write the files. A typecheck pass happens later.
