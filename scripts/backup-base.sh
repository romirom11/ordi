#!/usr/bin/env bash
# Daily Postgres base backup via WAL-G (PRD §19.2). Run from cron in the db
# container/host: 30 2 * * * /app/scripts/backup-base.sh
set -euo pipefail

: "${PGDATA:?PGDATA must be set}"
: "${WALG_S3_PREFIX:?WALG_S3_PREFIX must be set}"

echo "[backup] base backup starting $(date -Is)"
wal-g backup-push "$PGDATA"
echo "[backup] pruning old bases"
wal-g delete retain FULL 14 --confirm
echo "[backup] done $(date -Is)"
