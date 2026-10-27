#!/usr/bin/env bash
set -euo pipefail
point="${1:?Pass a mounted backup directory}"
test -f "$point/COMPLETE"
(cd "$point" && sha256sum -c SHA256SUMS)
# This deliberately refuses to replace an existing installation.
count="$(psql -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
[[ "$count" == 0 ]] || { echo 'Restore requires an empty database'; exit 1; }
[[ -z "$(find /files -mindepth 1 -print -quit)" ]] || { echo 'Restore requires an empty files volume'; exit 1; }
pg_restore --exit-on-error --dbname "$PGDATABASE" "$point/database.dump"
tar -xzf "$point/files.tar.gz" -C /files
echo 'Restore completed. Validate file hashes and permissions before switching traffic.'
