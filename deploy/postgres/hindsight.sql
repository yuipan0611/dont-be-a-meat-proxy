-- L-02: Hindsight's own database on the L-01 cluster (runbook-L01 §部署契約).
-- Run as postgres via `ops/postgres hindsight-init`; the password arrives through the environment
-- (never argv / SQL text / history). Idempotent: an existing role keeps its password.
select 'create database hindsight' where not exists (select from pg_database where datname = 'hindsight') \gexec
revoke connect on database hindsight from public;

\getenv hs_password HINDSIGHT_DB_PASSWORD
-- One explicit transaction: set_config(..., true) is transaction-local and psql autocommits per statement.
begin;
select set_config('hub.hs_password', :'hs_password', true) is not null as secret_loaded \gset
do $$
declare pw text := current_setting('hub.hs_password');
begin
  if pw !~ '^[0-9a-f]{64}$' then
    raise exception 'hindsight-db.password must contain exactly 64 lowercase hex characters';
  end if;
  if not exists (select from pg_roles where rolname = 'hindsight_app') then
    -- Not superuser, no createdb/createrole, no membership in service_role: it can never reach hub.
    execute format('create role hindsight_app login noinherit nosuperuser nocreatedb nocreaterole password %L', pw);
  end if;
end $$;
select set_config('hub.hs_password', '', true) is not null as secret_cleared \gset
commit;
\unset hs_password

alter database hindsight owner to hindsight_app;
grant connect on database hindsight to hindsight_app;
-- Hindsight runs its own Alembic migrations; it needs to own the public schema of ITS database only.
\connect hindsight
alter schema public owner to hindsight_app;
-- pgvector must be created by a superuser before Hindsight's first migration (it refuses otherwise).
create extension if not exists vector;
-- Hindsight connections are capped by HINDSIGHT_API_DB_POOL_MAX_SIZE; this is the hard backstop
-- inside max_connections=30 (runbook-L01: hub pools ≤5 each + ops headroom).
alter role hindsight_app connection limit 12;
