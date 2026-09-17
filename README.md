<div align="center">

<img src="docs/images/logo.png" alt="" width="96" height="96">

# ordi

**The operations system for small agencies and product teams.**
Projects, CRM, knowledge base, time, finance and people – one app, one database, one API.

[![CI](https://github.com/romirom11/ordi/actions/workflows/ci.yml/badge.svg)](https://github.com/romirom11/ordi/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/romirom11/ordi)](https://github.com/romirom11/ordi/releases/latest)

[Website](https://ordi.one) · [Quick start](#quick-start) · [Why ordi](#why-ordi) · [Features](#features) · [Deploy](#deploy-it-for-real) · [Desktop app](https://ordi.one/download) · [Hosted](https://ordi.one/pricing) · [Donate](#support-the-project)

[![Support ordi on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/T1H52733T3)

![Project overview](docs/images/project-overview.png)

</div>

---

## The problem

A ten-person agency ends up running on five subscriptions: Linear for tasks, a CRM
for the pipeline, Notion for documents, a timer app, and something for invoices.
Nothing knows about anything else. The hours logged against a task never reach the
invoice. The deal that became a project is retyped by hand. Nobody can answer
"did we make money on this client?" without a spreadsheet.

ordi is the other approach: one system where a deal becomes a project, the project's
tracked hours become an invoice, and the invoice posts to a real ledger – so the
margin on every project is a query, not an afternoon.

It is self-hosted, AGPL-licensed, and runs on one Postgres database.

## Why ordi

|  | ordi | Linear / Jira | Notion / ClickUp | Twenty / Odoo |
|---|---|---|---|---|
| Tasks with a real issue tracker feel | ✅ | ✅ | ⚠️ generic databases | ⚠️ basic |
| CRM with a pipeline | ✅ | ❌ | ⚠️ DIY | ✅ |
| Invoices, payments, double-entry ledger | ✅ | ❌ | ❌ | ✅ (heavy) |
| Time tracking tied to tasks and invoices | ✅ | ❌ | ⚠️ add-on | ⚠️ module |
| Knowledge base with permissions | ✅ | ❌ | ✅ | ❌ |
| HR: people, leave, compensation | ✅ | ❌ | ❌ | ✅ (heavy) |
| Project profitability out of the box | ✅ | ❌ | ❌ | ⚠️ configuration |
| Self-hosted, one database | ✅ | ❌ | ❌ | ✅ |
| Set up in an afternoon | ✅ | ✅ | ✅ | ❌ |

**Against Linear and Jira** – ordi's task experience is deliberately modelled on Linear:
keyboard-first, fast, opinionated. The difference is that the work connects to money.
A task carries hours, the hours carry rates, and the project tells you its margin.

**Against Notion and ClickUp** – those give you a toolkit and expect you to build the
system. ordi ships the system: real invoices with tax and payment terms, a real CRM
pipeline, real leave balances. Less freedom, far less setup.

**Against Odoo** – Odoo can do all of this and much more, after an implementation
project. ordi targets the ten-person agency that wants to be running today, not the
enterprise that needs manufacturing and payroll.

**Against Twenty** – Twenty is a beautiful open-source CRM. ordi is a CRM *and* the
delivery and finance system that follows the sale.

> Not for you if: you need manufacturing, inventory, payroll runs, or a hundred-seat
> deployment with SSO and custom workflow engines. ordi is built for teams of roughly
> 3 to 50 people.

## Features

<table>
<tr><td width="50%">

### Projects and tasks
Deliberately modelled on Linear: keyboard-first, fast, opinionated. Board, list,
calendar, timeline and spreadsheet views; cycles with burn-up and a burndown,
milestones, project updates with health; sub-tasks, dependencies, labels, custom
fields (workspace-wide or per project); saved views, filters and display options;
project templates; files with in-app previews on every task.

</td><td width="50%">

![Tasks](docs/images/project-tasks.png)

</td></tr>
<tr><td width="50%">

### CRM
Leads before qualification, deals after: companies, contacts, a daily Work queue,
first-class sales activities, playbooks, message templates and follow-up sequences,
CSV import/export and bulk actions. A drag-and-drop deal pipeline with a weighted
forecast, and an Analytics tab with funnel, conversion, pipeline by stage and win
rate. A won deal turns into a project without retyping anything.

</td><td width="50%">

![CRM pipeline](docs/images/crm-pipeline.png)

</td></tr>
<tr><td width="50%">

### Finance
Quotes and invoices with tax, discounts, branded localized PDFs and public payment
pages. Payments, credit notes, recurring invoices and expenses; receivables aging
and overdue reminders; invoice straight from unbilled time; project profitability
out of the box. Underneath sits a **double-entry ledger** – every invoice, payment
and expense posts balanced entries, so the books actually balance.

</td><td width="50%">

![Finance](docs/images/finance.png)

</td></tr>
</table>

### And the rest

- **Knowledge base** – Notion-style editor, spaces with per-space permissions, nested
  pages, versions, backlinks, publishing and Markdown export. A page can be a PDF,
  so contracts and briefs read inline next to the articles.
- **Time** – timers and manual entries against tasks, billable rates and cost rates,
  a weekly view and reports, invoice-from-time.
- **People** – employee records with access-controlled field groups and a
  questionnaire, org structure, a team calendar of absences, holidays and birthdays,
  self-service leave with balances and manager approvals, versioned compensation
  with audited access, recruiting with public careers pages.
- **Resourcing and dashboards** – capacity planning, team availability and custom
  dashboard widgets.
- **Requests come to you** – public intake forms, email intake over IMAP with
  attachments, and `/ordi` in Slack; a project Intake tab triages each request into
  a task or a decline, mailing the requester either way.
- **Slack that sets itself up** – paste one token and ordi creates the Slack app;
  project events post to a bound channel.
- **GitHub, wired to tasks** – a GitHub App created from ordi in one click; every
  task hands you a branch name, and branches, commits and pull requests that
  mention the task key attach themselves to it, with automation rules that move
  the task as the PR moves.
- **Realtime** – assignments and mentions arrive over SSE with a toast and a sound.
  No refresh.
- **Rich text everywhere** – `@` to mention people, `#` to reference tasks, KB pages,
  companies and invoices; comments can be edited and carry emoji reactions.
- **Modules you can switch off** – run ordi as just a task tracker, or just a CRM.
  A module turned off disappears from the navigation, the search and the
  permissions.
- **Permissions that hold** – enforced on every request, the UI only hides things;
  audit diffs redact sensitive fields, writes use optimistic locking.
- **Built-in MCP server** – point Claude or Cursor at your workspace over OAuth with
  PKCE; the agent gets exactly the permissions of its API token, nothing more.
- **AI agent employees** – add an agent as a team member, assign it a task like you
  would a person, and it works through the project's repository and opens a pull
  request for a human to review. Runs on your own Claude subscription or API key,
  with MCP connectors granted per agent.
- **Desktop app** – macOS, Windows and Linux, with native notifications, a global
  quick-add shortcut, signed auto-updates, and sign-in through your browser
  instead of retyping credentials. Downloadable from inside the web app.
- **Setup wizard, invites and password reset** – the first run creates the
  workspace, owner account, currency and modules on one screen; members arrive by
  invite.
- **English and Ukrainian**, dark and light.

## Quick start

Requires **Docker**. Nothing else – no clone, no build. Every release publishes
the whole app (API, workers and web app) as one image,
[`ghcr.io/romirom11/ordi`](https://github.com/romirom11/ordi/pkgs/container/ordi).

```bash
mkdir ordi && cd ordi
curl -fsSLO https://raw.githubusercontent.com/romirom11/ordi/master/docker-compose.yml
docker compose up
```

Open <http://localhost:8080> and the setup wizard will create your workspace and
owner account.

`docker compose pull` moves you to the newest release; `ORDI_VERSION=1.33.0`
in a `.env` next to the compose file pins one (and is how you roll back). The
image is `linux/amd64`.

<details>
<summary><b>Run from source instead</b> (Node 22, pnpm 10, PostgreSQL 16)</summary>

```bash
pnpm install
cp .env.example .env               # set DATABASE_URL

pnpm db:migrate                    # schema + triggers
pnpm db:seed                       # demo workspace (optional but recommended)

pnpm api:dev                       # http://localhost:3000
pnpm web:dev                       # http://localhost:5173
```

The seed creates a full demo agency – clients, a live project with a sprint,
invoices with ledger entries, logged time and a knowledge base – so you can judge
the product in a minute rather than staring at empty states.

Sign in as `owner@ordi.local` / `password123`.

To build the container image from your checkout instead of pulling the
published one (a fork, or a change to `docker/Dockerfile.api`):

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up --build
```

</details>

## Deploy it for real

[`docs/deployment.md`](docs/deployment.md) covers a production deployment with
docker-compose or Dokploy: TLS, SMTP and DNS records, S3-compatible storage,
backups and health checks. Production runs the same published image through
[`docker-compose.prod.yml`](docker-compose.prod.yml), so a server never builds
anything – updating is `docker compose pull` or a redeploy from the panel.
[`docs/operations.md`](docs/operations.md) covers backup/PITR targets,
monitoring and the restore runbook.

The desktop app connects to your instance – download it from
[ordi.one/download](https://ordi.one/download), from
[Releases](https://github.com/romirom11/ordi/releases/latest), or from inside the web
app; enter your URL on first launch and sign in through your browser. How the shell
works is in [`docs/desktop.md`](docs/desktop.md).

### Or don't run a server

If you would rather not keep a machine alive, [ordi.one](https://ordi.one/pricing) runs
the same published image for you: your own container, Postgres database, subdomain and
storage bucket, with nightly backups and upgrades applied. It is one price per instance
with every person on your team included, and it buys hosting rather than features –
nothing in this repository is held back for it, and a database dump moves you in or out
in either direction.

## How it is built

| Layer | Tech |
|---|---|
| Database | PostgreSQL 16 – JSONB, full-text search, triggers |
| API | Hono on Node 22, TypeScript, Zod-validated, OpenAPI at `/api/docs` |
| ORM | Drizzle with SQL migrations |
| Web | React 19, Vite, TanStack Query, Tailwind |
| Queue | pg-boss, on the same Postgres – no Redis |
| Desktop | Tauri 2 |
| Monorepo | pnpm workspaces + Turborepo |

```
apps/api         Hono API – domain modules and background workers
apps/web         React SPA (also the desktop UI)
apps/desktop     Tauri shell
packages/db      Drizzle schema, migrations, triggers
packages/shared  Zod schemas, permission catalog, pure calculations
packages/mcp     MCP server over the REST API
```

Design notes and the reasoning behind the bigger decisions live in
[`docs/architecture-decisions.md`](docs/architecture-decisions.md); the original
product spec is [`docs/prd.md`](docs/prd.md). The living feature registry –
what's planned, in flight and shipped – is [`docs/features.md`](docs/features.md).

A few principles the codebase holds to: permissions are enforced on every request
and the UI only hides things; writes use optimistic locking with a `version` column;
audit diffs redact sensitive fields; migrations are additive and run by the `api`
container before it starts serving, so one container owns the schema.

## Contributing

Issues and pull requests are welcome – see [CONTRIBUTING.md](CONTRIBUTING.md) for
the setup, the conventions and what makes a change easy to merge. Security reports
go through [SECURITY.md](SECURITY.md), not public issues.

## Support the project

ordi is free and AGPL-licensed, built and maintained in the open. If it saves
your team a subscription or two and you want to say thanks, donations are
welcome:

<a href="https://ko-fi.com/T1H52733T3"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support ordi on Ko-fi"></a>

Prefer crypto?

```
0x3416baba090f1fb87998f73fe1ae625f38865a64
```

Ethereum and any EVM-compatible chain (Arbitrum, Base, Optimism, Polygon, BNB
Chain). USDT and USDC on those networks work too – just double-check you are
sending on a network this address is used on.

Nothing here is paywalled and nothing will be: donations fund the time, not a
tier.

## License

[AGPL-3.0](LICENSE). You can run ordi for your own company, modify it and
self-host it freely. If you offer a modified ordi to others over a network, the
AGPL requires you to publish your changes.
