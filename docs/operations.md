# ordi – Operations runbook

Covers backup/restore with formal RPO/RTO targets (PRD §19.2), deployment, and
monitoring. Written for a solo operator on Dokploy + Docker.

## 1. Targets (mandatory)

| Metric | Target | Mechanism |
|---|---|---|
| **RPO** (max data loss) | ≤ 5 minutes | Continuous WAL archiving to S3 + periodic base backups (PITR) |
| **RTO** (max time to recover) | ≤ 1 hour | Rehearsed restore runbook (below), measured quarterly |
| Attachments RPO | ~0 (replication lag) | S3 bucket versioning + cross-region replication |

A plain nightly dump does NOT meet the RPO – WAL archiving is required.

## 2. Postgres PITR setup

Use [WAL-G](https://github.com/wal-g/wal-g) (or `wal-e`/`pgbackrest`) against the
same S3-compatible storage as attachments (separate bucket/prefix).

`postgresql.conf` (in the db container/volume):

```conf
wal_level = replica
archive_mode = on
archive_timeout = 60            # force a WAL segment at least every 60s → RPO ≤ ~1-2 min
archive_command = 'wal-g wal-push %p'
```

WAL-G env (db container):

```bash
WALG_S3_PREFIX=s3://ordi-backups/pg
AWS_ENDPOINT=...          # MinIO/R2 endpoint
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Base backup – run daily via cron (see `scripts/backup-base.sh`):

```bash
wal-g backup-push "$PGDATA"
wal-g delete retain FULL 14 --confirm   # keep 14 daily bases
```

The `events`, `processed_events`, dead-letter, `email_deliveries` and
`sales_digest_runs` tables live in the same DB. An event, queued email or digest
claim committed before a crash therefore remains inside the same PITR perimeter;
no separate queue backup is needed (the pg-boss schema `pgboss` is covered too).
Outbox consumers and enqueue operations are idempotent. SMTP itself is
at-least-once: a crash after provider acceptance but before the row is marked
`sent` can produce a duplicate retry.

## 3. Restore procedure (rehearse quarterly, measure RTO)

1. **Provision** a fresh Postgres 16 instance (empty volume).
2. **Fetch base**: `wal-g backup-fetch "$PGDATA" LATEST`.
3. **Configure recovery** (`postgresql.conf` additions):
   ```conf
   restore_command = 'wal-g wal-fetch %f %p'
   recovery_target_time = '2026-07-24 12:34:56+00'   # or omit for end-of-WAL
   ```
   and create `recovery.signal` in `$PGDATA`.
4. **Start** Postgres; watch logs until `recovery stopping before commit …` /
   `database system is ready`.
5. **Attachments**: point `S3_*` env at the replica bucket (or restore versioned
   objects). Attachment rows in the DB reference stable `file_key`s, so no
   re-linking is needed.
6. **Switch traffic**: update `DATABASE_URL` on the API service, redeploy,
   verify `/readyz`, run one smoke flow (login → open a project → open an
   invoice PDF).
7. **Record** the measured wall-clock time in this file's log below. If it
   exceeds 1 hour, treat as a release blocker and fix the bottleneck.

| Date | Operator | Measured RTO | Notes |
|---|---|---|---|
| _fill on each rehearsal_ | | | |

## 4. Deployment

- Migrations are **additive** and run as a separate step before switching
  traffic: the API container entrypoint runs `pnpm --filter @ordi/db migrate`
  first; on Dokploy use a pre-deploy command with the same call.
- Health: `GET /healthz` (liveness), `GET /readyz` (DB reachable). Wire both
  into Dokploy health checks and OneUptime monitors.
- Rollback: previous image + the additive schema keeps working (no destructive
  DDL is ever generated; see docs/architecture-decisions.md §3).

## 5. Monitoring & alerts (OneUptime or similar)

Alert on:
- `/healthz` or `/readyz` failing (1-minute interval).
- **Dead-letter depth**: `SELECT count(*) FROM dead_letter_events WHERE attempts >= 5 AND replayed_at IS NULL;` > 0 for 15 min.
- **WAL archiving lag**: `SELECT last_archived_time FROM pg_stat_archiver;` older than 10 minutes.
- **Outbox lag**: `SELECT count(*) FROM events WHERE published_at IS NULL AND occurred_at < now() - interval '5 minutes';` > 0.
- **Email dead letters**: `SELECT count(*) FROM email_deliveries WHERE status = 'dead';` > 0 for 15 min.
- **Email queue lag**: `SELECT count(*) FROM email_deliveries WHERE status = 'pending' AND next_attempt_at < now() - interval '5 minutes';` grows for 15 min.
- **Stale email claims**: `SELECT count(*) FROM email_deliveries WHERE status = 'sending' AND updated_at < now() - interval '5 minutes';` > 0 across two checks. The worker should reclaim these automatically.
- **Sales digest scheduler**: `SELECT max(created_at) FROM sales_digest_runs;` is older than 30 hours while active human users with `crm.read` exist. The ledger records empty mornings, so no row usually means the scheduler did not run.
- Disk usage on the DB volume > 80%.

Errors: set `SENTRY_DSN` (API) and `VITE_SENTRY_DSN` (web build) – the built-in
lightweight reporter posts exceptions to Sentry without extra dependencies.
Logs are pino JSON on stdout with `request_id` – ship via Dokploy log driver.
Alert specifically on repeated `email delivery tick failed`, `email delivery
dead-lettered`, `sales digest failed` and `initial sales digest failed` messages.

## 6. Agent runs

The agent worker runs inside the API container (`AGENT_WORKER_ENABLED`, default
on) unless it has been split into its own service – see docs/deployment.md §3b.

**Disk.** Every run gets a fresh clone under `/data/agent-work/<runId>` and the
directory is deleted when the run finishes, fails or is cancelled. Nothing
accumulates in normal operation, so size the volume for the *peak*:
`AGENT_WORKER_CONCURRENCY` × repository size (× replicas, if more than one
container claims runs), plus headroom for build output the agent produces
inside the checkout. A crash can leave a directory behind – the next run of the
same id would recreate it, but a container that died mid-run leaves an orphan;
alert on volume usage the same way as on the DB volume, and it is safe to
delete any `/data/agent-work/*` directory whose run is no longer `running`.

**Worker liveness.** Workers write a heartbeat to `agent_workers` every 15s
(id, concurrency, in-flight runs, whether the Claude runtime resolved, version).
Settings → Agents lists them and greys out anything not seen for ~35s.

```sql
SELECT id, last_seen_at, running, concurrency, runtime_available
FROM agent_workers ORDER BY last_seen_at DESC;
```

`runtime_available = false` means the process imported the Agent SDK and did
not find its bundled binary – the image is wrong, not the credential.

**Stale runs.** A run whose worker vanishes is re-queued: rows in `claimed` or
`running` untouched for 3 minutes go back to `queued`, and after 3 attempts the
run is failed with "the worker running this run stopped responding". The
per-run API token is revoked on every one of those transitions, so a lost
worker cannot keep writing as the agent.

**Event log growth.** `agent_run_events` is one row per SDK message, tool call
and connector call, so a long run is a few hundred rows. It is the live log on
the task page and the audit trail of what the agent did, so it is not pruned
automatically; if it becomes the largest table, delete events for finished runs
older than the retention you want (the run row itself keeps the summary). Known
secret values are scrubbed out of every payload before it is stored – provider
credentials, connector headers, OAuth tokens – so the log is safe to read and
to ship to a log collector.

**Runs stuck in `queued`.** In order of likelihood:

- no worker: `agent_workers` empty or stale (`AGENT_WORKER_ENABLED=0`
  everywhere, or the container is down);
- no usable credential: the workspace Claude credential is missing, revoked or
  expired – the agent shows "credential required" and dispatch is skipped;
- the agent is not a member of the task's project, or is disabled;
- per-agent `concurrency` or `AGENT_WORKER_CONCURRENCY` is already saturated by
  other runs (check `running` in the heartbeat).

A run that nobody claims within ten minutes notifies the task author, so a
silent queue is normally reported before anyone reads this file.

**Connectors in `needs_auth`.** An OAuth connector whose refresh failed (token
revoked upstream, or the provider rotated the client) is excluded from new runs
and shows "Re-authorize" on its card; runs continue with the remaining
connectors rather than failing. The fix is a human clicking through consent
again, which needs the public callback URL to be reachable (deployment.md §3b).

## 7. Secrets

All secrets come exclusively from env (PRD §19.1): `AUTH_SECRET`,
`ENCRYPTION_KEY` (32-byte hex, AES-256-GCM for git credentials), `DATABASE_URL`,
`SMTP_URL`, `S3_*`. Rotate `ENCRYPTION_KEY` by re-encrypting `git_connections`
(reconnect integrations) – the key is never stored in the DB. The same key
encrypts the workspace Claude credential and the MCP connector secrets, so a
rotation means reconnecting those too (deployment.md §3b): agents show
"credential required" and connectors `needs_auth` until you do.

## 8. Sensitive-audit retention (PRD §14.4)

`workspace_settings.sensitive_audit_retention_months` (default 24). Purge job
(manual or cron):

```sql
UPDATE activity_log SET diff = '{}'::jsonb
WHERE sensitivity = 'sensitive'
  AND created_at < now() - (SELECT sensitive_audit_retention_months || ' months'
                            FROM workspace_settings LIMIT 1)::interval;
```

Normal audit is kept indefinitely.
