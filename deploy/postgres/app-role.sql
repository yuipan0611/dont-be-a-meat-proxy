-- Password comes from a Docker secret, never SQL arguments, source or history.
-- Only generated 256-bit hex values are accepted to keep provisioning predictable.
\getenv app_password HUB_APP_PASSWORD
select set_config('hub.app_password', :'app_password', true) is not null as secret_loaded \gset
do $$
declare pw text := current_setting('hub.app_password');
begin
  if pw !~ '^[0-9a-f]{64}$' then
    raise exception 'hub-app.password must contain exactly 64 lowercase hex characters';
  end if;
  if not exists (select from pg_roles where rolname = 'hub_app') then
    execute format('create role hub_app login noinherit password %L', pw);
  end if;
end $$;
grant service_role to hub_app;
alter role hub_app set role = 'service_role';
grant connect on database hub to hub_app;
select set_config('hub.app_password', '', true) is not null as secret_cleared \gset
\unset app_password
