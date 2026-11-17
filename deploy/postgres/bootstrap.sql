-- Cluster provisioning only; migrations and app tables stay in database hub.
select 'create database hub' where not exists (select from pg_database where datname = 'hub') \gexec
revoke connect on database hub from public;
revoke connect on database postgres from public;
revoke connect on database template1 from public;
