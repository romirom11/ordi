# ordi — Operations runbook

Covers backup/restore with formal RPO/RTO targets (PRD §19.2), deployment, and
monitoring. Written for a solo operator on Dokploy + Docker.

## 1. Targets (mandatory)

| Metric | Target | Mechanism |
|---|---|---|
| **RPO** (max data loss) | ≤ 5 minutes | Continuous WAL archiving to S3 + periodic base backups (PITR) |
| **RTO** (max time to recover) | ≤ 1 hour | Rehearsed restore runbook (below), measured quarterly |
| Attachments RPO | ~0 (replication lag) | S3 bucket versioning + cross-region replication |

A plain nightly dump does NOT meet the RPO — WAL archiving is required.

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

Base backup — run daily via cron (see `scripts/backup-base.sh`):

```bash
wal-g backup-push "$PGDATA"
wal-g delete retain FULL 14 --confirm   # keep 14 daily bases
```

The `events`, `processed_events` and dead-letter tables live in the same DB, so
an event committed before a crash survives restore exactly once (outbox +
processed_events dedup) — no separate queue backup is needed (pg-boss schema
`pgboss` is also inside the same PITR perimeter).

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
- Disk usage on the DB volume > 80%.

Errors: set `SENTRY_DSN` (API) and `VITE_SENTRY_DSN` (web build) — the built-in
lightweight reporter posts exceptions to Sentry without extra dependencies.
Logs are pino JSON on stdout with `request_id` — ship via Dokploy log driver.

## 6. Secrets

All secrets come exclusively from env (PRD §19.1): `AUTH_SECRET`,
`ENCRYPTION_KEY` (32-byte hex, AES-256-GCM for git credentials), `DATABASE_URL`,
`SMTP_URL`, `S3_*`. Rotate `ENCRYPTION_KEY` by re-encrypting `git_connections`
(reconnect integrations) — the key is never stored in the DB.

## 7. Sensitive-audit retention (PRD §14.4)

`workspace_settings.sensitive_audit_retention_months` (default 24). Purge job
(manual or cron):

```sql
UPDATE activity_log SET diff = '{}'::jsonb
WHERE sensitivity = 'sensitive'
  AND created_at < now() - (SELECT sensitive_audit_retention_months || ' months'
                            FROM workspace_settings LIMIT 1)::interval;
```

Normal audit is kept indefinitely.
