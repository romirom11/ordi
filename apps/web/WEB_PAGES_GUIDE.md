# ordi web — page authoring guide

You implement React 19 page components under `apps/web/src/pages/`. Each page is a named export used by `apps/web/src/routes.tsx` / `main.tsx`. Only create files under `apps/web/src/pages/`. Do not edit shared/config/components (they already exist).

## Building blocks (import these)
- `import { api, qs } from '../lib/api'` — `api.get/post/patch/del<T>(path)`; `qs({...})` builds a query string. Cookie auth is automatic. Errors throw `ApiError` with `.status`, `.code`, `.message`.
- `import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'`.
- `import { Link, useNavigate, useSearchParams } from '../lib/router'` (public pages: `../../lib/router`).
- `import { useMe, useCan } from '../lib/auth'` — `const can = useCan(); can('finance.read')`. Public pages must NOT use these.
- UI: `import { Button, Input, Textarea, Select, Card, Badge, PageHeader, EmptyState, Spinner, Skeleton, fmtMoney, fmtDate, cn } from '../components/ui'` (public: `../../components/ui`).
- Icons: `lucide-react`.

## Conventions
- Density: rows ~40px, `text-sm`, one accent color, muted-foreground for secondary text. Match the Shell/ui look. Support light+dark automatically (use the CSS vars via tailwind tokens: `bg-card`, `text-muted-foreground`, `border-border`, etc.). Never hardcode colors except status/priority dots.
- Every list: loading (Skeleton) / empty (EmptyState with a teaching sentence + primary action) / data.
- Permissions form the UI: hide sections/actions the user can't use (`can(...)`). Don't render finance tiles without `finance.read`, etc.
- Use `useQueryClient().invalidateQueries({queryKey:[...]})` after mutations. Optimistic where easy; always show errors (a simple inline message or `alert` is acceptable, prefer inline).
- Keep components typecheck-clean (strict). Type API responses loosely with interfaces at the top of the file; `any` is acceptable for nested JSON.
- Peek panels: for task/invoice detail you may use a right-side drawer (fixed right panel) or a full page — your call; keep it simple.

## API endpoints (all under /api/v1, cookie auth)
- me: `GET /me` -> {user, permissions[], projectMemberships[], spaceMemberships[]}
- dashboard: `GET /dashboard` -> {myTasks:{overdue,today,upcoming}, receivables?, overdue?, dealsByStage?, recentActivity[], projectCount}
- search: `GET /search?q=`
- CRM: `GET /companies?q=&status=&ownerId=`, `POST /companies`, `GET /companies/:id`, `GET /companies/:id/overview`, `PATCH /companies/:id`, `DELETE /companies/:id`; contacts `GET /contacts?companyId=`,`POST /contacts`; deal-stages `GET /deal-stages`; deals `GET /deals?companyId=`,`POST /deals`,`POST /deals/:id/move {stageId,lostReason?,version?}`; notes `GET /notes?companyId=`,`POST /notes`.
- Projects: `GET /projects`, `POST /projects`, `GET /projects/:id`, `PATCH /projects/:id`; members `GET /projects/:id/members`,`POST`; statuses `GET /projects/:id/task-statuses`,`POST`; types `GET /task-types?projectId=`; project-types `GET /project-types`; cycles `GET /projects/:id/cycles`,`POST /cycles`,`POST /cycles/:id/complete`.
- Tasks: `GET /tasks?projectId=&status=&priority=&assignee=&q=`, `POST /tasks`, `GET /tasks/:id?include=assignees,labels,comments,relations,links,git_links`, `PATCH /tasks/:id`, `DELETE /tasks/:id`, `POST /tasks/:id/move`, `POST /tasks/:id/duplicate`; comments `GET/POST /tasks/:id/comments`; labels `GET /labels`; `GET /me/tasks`.
- KB: `GET /spaces`, `POST /spaces`, `GET /spaces/:id/pages`, `POST /pages`, `GET /pages/:id`, `PATCH /pages/:id`, `GET /pages/:id/versions`, `POST /pages/:id/restore {versionNo}`.
- Time: `GET /time/entries?from=&to=`, `POST /time/entries`, `POST /time/timer/start {taskId,note}`, `POST /time/timer/stop`, `GET /time/timer`, `GET /time/reports?...`, `GET /time/my-week?weekStart=`, `GET /time/unbilled?companyId=`.
- Finance: `GET /invoices?status=&companyId=`, `POST /invoices`, `GET /invoices/:id`, `POST /invoices/:id/send`, `POST /invoices/:id/cancel`, `GET /invoices/:id/pdf` (binary), `POST /invoices/from-time`; payments `POST /invoices/:id/payments`; `GET /quotes`,`POST /quotes`,`POST /quotes/:id/send`,`POST /quotes/:id/convert`; `GET /finance/dashboard`; `GET /finance/profitability?scope=`; `GET /expenses`,`POST /expenses`; `GET /tax-rates`.
- People: `GET /employees`, `POST /employees`, `GET /employees/:id`, `POST /employees/:id/lifecycle`; `GET /leave-requests`,`POST /leave-requests`,`POST /leave-requests/:id/approve`; `GET /leave-types`; `GET /departments`; `GET /job-openings`,`POST /job-openings`; `GET /applicants?jobOpeningId=`,`POST /applicants/:id/move`,`POST /applicants/:id/hire`; `GET /applicant-stages`; `GET /people/dashboard`; `GET /employees/:id/compensation` (needs people.read_compensation).
- Settings: `GET /roles`, `GET /roles/catalog`, `POST/PATCH /roles`; `GET /users`, `POST /users/invite`, `PATCH /users/:id/role`; `GET /custom-fields?entityType=`, `POST /custom-fields`; `GET /settings/workspace`, `PATCH /settings/workspace`; `GET /integrations/git/connections`; `GET /webhooks`.
- Notifications: `GET /notifications`, `POST /notifications/read-all`.
- Public (no auth): `GET /i/:token`, `GET /q/:token`, `POST /q/:token/decision {decision,comment}`, `GET /portal/:token`, `GET /intake/:token`, `POST /intake/:token`, `GET /careers/:token`, `POST /careers/:token`.
- Auth: `POST /auth/login {email,password,totp?}`, `POST /auth/logout`, `GET /auth/invite/:token`, `POST /auth/accept-invite {token,name,password}`.

Numeric/money values may arrive as strings — wrap with Number() before math and use fmtMoney for display.
