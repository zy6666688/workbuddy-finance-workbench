#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /backups
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="/backups/$stamp"
mkdir "$target"
trap 'printf "{\"status\":\"failed\",\"at\":\"%s\"}\n" "$(date -u +%FT%TZ)" > /backups/latest.json' ERR
pg_dump -Fc --no-owner --file "$target/database.dump"
tar -czf "$target/files.tar.gz" -C /files .
(cd "$target" && sha256sum database.dump files.tar.gz > SHA256SUMS)
touch "$target/COMPLETE"
printf '{"status":"completed","at":"%s","directory":"%s"}\n' "$(date -u +%FT%TZ)" "$stamp" > /backups/latest.json
chmod 644 /backups/latest.json
# Only remove complete recovery points in this dedicated backup root.
mapfile -t old < <(find /backups -mindepth 2 -maxdepth 2 -name COMPLETE -printf '%h\n' | sort -r | awk '{day=substr($0,length($0)-15,8);if(!seen[day]++){days++}if(days>30)print}')
for directory in "${old[@]}"; do
  [[ "$directory" =~ ^/backups/[0-9]{8}T[0-9]{6}Z$ ]] || exit 1
  rm -r -- "$directory"
done
echo "backup completed: $stamp"
