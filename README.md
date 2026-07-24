# ordi

**Agency operations platform** — one app, one database, one API for CRM, Projects,
Knowledge Base, Time, Finance and People (HR), with cross-cutting RBAC, an event
bus, git integrations, search, notifications, audit and an MCP agent.

Built to the spec in [`docs/prd.md`](docs/prd.md) (v3.1). Engineering decisions
and refinements are logged in [`docs/architecture-decisions.md`](docs/architecture-decisions.md).

## Stack

| Layer | Tech |
|---|---|
| DB | PostgreSQL 16 (JSONB, FTS, triggers) |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| API | Hono (Node 22, TypeScript) |
| Validation | Zod (shared schemas in `packages/shared`) |
| Web | React 19 + Vite + TanStack Query |
| UI | Tailwind, shadcn-style primitives |
| Queue | pg-boss (on Postgres, no Redis) |
| PDF | Typst (with dependency-free fallback) |
| Email / Files | Nodemailer + SMTP / S3-compatible |
| MCP | `@modelcontextprotocol/sdk` |
| Monorepo | pnpm workspaces + Turborepo |

## Layout

```
ordi/
├── apps/
│   ├── api/        # Hono API — domain modules + pg-boss workers
│   ├── web/        # React SPA
│   └── desktop/    # Tauri wrapper of apps/web
├── packages/
│   ├── shared/     # Zod schemas, permission catalog, event catalog, pure calc
│   ├── db/         # Drizzle schema, migrations, triggers
│   └── mcp/        # MCP server (REST client)
├── docker/         # Dockerfiles + nginx
└── docs/           # prd.md, architecture-decisions.md
```

## Quick start (local)

Requires Node 22, pnpm 10, and a PostgreSQL 16 instance.

```bash
pnpm install
cp .env.example .env            # edit DATABASE_URL etc.

# create the schema + triggers, then seed roles/owner/demo data
pnpm --filter @ordi/db migrate
pnpm --filter @ordi/api seed

# run API (http://localhost:3000) and web (http://localhost:5173)
pnpm --filter @ordi/api dev
pnpm --filter @ordi/web dev
```

Sign in with the seeded owner: **`owner@ordi.local` / `password123`**
(a `member@ordi.local / password123` demo user is also created).

## Quick start (Docker)

```bash
docker compose up --build
# web:   http://localhost:8080
# api:   http://localhost:3000
# minio: http://localhost:9001  (ordi / ordi-secret)
```
The API container runs migrations on start. Seed once with:
```bash
docker compose exec api pnpm --filter @ordi/api seed
```

## Commands

```bash
pnpm build         # turbo build all
pnpm typecheck     # tsc across packages
pnpm test          # vitest across packages
pnpm db:generate   # generate a new Drizzle migration from schema changes
pnpm db:migrate    # apply migrations + triggers
pnpm db:seed       # seed roles + demo data
```

## MCP agent

The MCP server exposes the API as agent tools (read + non-destructive actions).
The agent's permissions equal its API-token scope — the same RBAC as a human.

```bash
ORDI_API_URL=http://localhost:3000 ORDI_API_TOKEN=<token> pnpm --filter @ordi/mcp dev
```
Create a token in the app under **Settings → API tokens** (scope ⊆ your role).

## Feature highlights

- Tasks in 5 views: List, Board, Calendar, Timeline (Gantt), Spreadsheet — plus
  saved views, drafts, cycles with burndown, intake (public form + IMAP).
- Tiptap rich text with @mentions everywhere (tasks, KB, notes); KB versions,
  soft-locks, backlinks, Markdown export.
- Finance: full invoice/quote lifecycle, localized PDF (uk/en, Typst), public
  pages, portal, payments/credit notes, recurring, reminders, invoice-from-time,
  profitability & labor cost (Productive-style).
- People: lifecycle, leave with balances, recruiting with public careers pages,
  versioned compensation (audited access), resourcing view.
- Realtime SSE cache invalidation, ⌘K palette, keyboard scheme (C/T/G-chords),
  custom dashboards, uk/en UI, OpenAPI at `/api/docs`, CSV import/export,
  dead-letter admin with replay, TOTP 2FA, MCP agent (31 tools).

Docs: [`docs/deployment.md`](docs/deployment.md) — production deployment
(Dokploy / docker-compose); [`docs/operations.md`](docs/operations.md) —
backup/PITR (RPO ≤ 5 min, RTO ≤ 1 h), monitoring, restore runbook;
[`docs/desktop.md`](docs/desktop.md) — how the desktop app works (instance URL,
bearer auth, native features, releases);
[`docs/architecture-decisions.md`](docs/architecture-decisions.md) —
engineering decisions log.

## Security & operations

- RBAC enforced on every request; UI only hides. 403s are audited with the
  required permission.
- Optimistic locking via a monotonic `version` (409 on conflict).
- Audit diffs redact sensitive fields (compensation, persona) and exclude secrets.
- Additive migrations run as a separate deploy step; `/healthz` + `/readyz` probes.
- Backups target RPO ≤ 5 min / RTO ≤ 1 h via Postgres PITR + S3 attachment
  replication (see PRD §19.2).

## License

Proprietary — internal agency tool.
