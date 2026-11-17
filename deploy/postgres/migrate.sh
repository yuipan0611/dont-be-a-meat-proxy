#!/usr/bin/env bash
# Standard psql application (docs/08 §6), with atomic batch and checksum ledger.
set -euo pipefail
# Compose file secrets preserve root:root 0600 on Linux. Read as operator root,
# rather than asking the unprivileged postgres server to read the secret file.
export HUB_APP_PASSWORD="$(cat /run/secrets/hub_app_password)"
if [[ ! "$HUB_APP_PASSWORD" =~ ^[0-9a-f]{64}$ ]]; then
  echo 'ERROR: hub-app.password must contain exactly 64 lowercase hex characters' >&2
  exit 1
fi
psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -f /opt/hub-postgres/bootstrap.sql
SQL_BATCH="$(mktemp)"
trap 'rm -f "$SQL_BATCH"' EXIT
cat > "$SQL_BATCH" <<'SQL'
select pg_advisory_xact_lock(170017001);
create schema if not exists _hub_ops;
revoke all on schema _hub_ops from public;
create table if not exists _hub_ops.migrations (
  filename text primary key,
  sha256 text not null,
  applied_at timestamptz not null default now()
);
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
SQL
shopt -s nullglob
files=(/supabase/migrations/*.sql)
if (( ${#files[@]} == 0 )); then echo 'ERROR: no migration files' >&2; exit 1; fi
for file in "${files[@]}"; do
  name="$(basename "$file")"
  if [[ ! "$name" =~ ^[0-9]{14}_[a-z0-9_]+\.sql$ ]]; then echo 'ERROR: invalid migration filename' >&2; exit 1; fi
  checksum="$(sha256sum "$file" | cut -d ' ' -f 1)"
  cat >> "$SQL_BATCH" <<SQL
DO \$\$ BEGIN
  IF EXISTS (SELECT FROM _hub_ops.migrations WHERE filename = '$name' AND sha256 <> '$checksum') THEN
    RAISE EXCEPTION 'applied migration checksum changed: $name';
  END IF;
END \$\$;
select exists(select from _hub_ops.migrations where filename = '$name') as applied \gset
\if :applied
\echo SKIP $name
\else
\echo APPLY $name
\i $file
insert into _hub_ops.migrations(filename,sha256) values ('$name','$checksum');
\endif
SQL
done
cat >> "$SQL_BATCH" <<'SQL'
revoke all on schema _hub_ops from anon, authenticated, service_role;
grant usage on schema extensions to service_role;
\i /opt/hub-postgres/app-role.sql
SQL
psql -X -U postgres -d hub -v ON_ERROR_STOP=1 --single-transaction -f "$SQL_BATCH"
