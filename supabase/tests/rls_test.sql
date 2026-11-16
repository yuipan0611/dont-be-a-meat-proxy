-- ============================================================================
-- RLS／權限／不變量測試（純 SQL，psql -v ON_ERROR_STOP=1 執行；任何 assert 失敗即非 0 結束）
-- 用法：psql -v ON_ERROR_STOP=1 -f supabase/tests/rls_test.sql
-- 以 superuser（postgres）連線；全部包在交易內最後 ROLLBACK，不改資料。
-- 註：Supabase 官方慣例是 pgTAP（supabase test db）；postgres:17 image 沒有 pgTAP，
--     故先用純 SQL assert，內容可原樣改寫成 pgTAP。
-- ============================================================================
\set QUIET on
begin;

-- T1 anon 讀 devices → 權限拒絕（grant 層）
set local role anon;
do $$
begin
  perform count(*) from public.devices;
  raise exception 'T1 FAIL: anon could read devices';
exception when insufficient_privilege then
  raise notice 'T1 PASS: anon select devices -> permission denied';
end $$;
reset role;

-- T2 authenticated 讀 devices → 權限拒絕
set local role authenticated;
do $$
begin
  perform count(*) from public.devices;
  raise exception 'T2 FAIL: authenticated could read devices';
exception when insufficient_privilege then
  raise notice 'T2 PASS: authenticated select devices -> permission denied';
end $$;
reset role;

-- T3 就算日後誤授 SELECT 給 anon，RLS（無 anon policy）仍回 0 列
savepoint t3;
grant select on public.devices to anon;
set local role anon;
do $$
declare n int;
begin
  select count(*) into n from public.devices;
  if n <> 0 then raise exception 'T3 FAIL: anon saw % rows with grant but no policy', n; end if;
  raise notice 'T3 PASS: anon with mistaken GRANT still sees 0 rows (RLS)';
end $$;
reset role;
rollback to savepoint t3;

-- T4 service_role 讀得到兩台裝置與匯出 view
set local role service_role;
do $$
declare n int; e int;
begin
  select count(*) into n from public.devices;
  select count(*) into e from public.caddy_allowlist_export;
  if n <> 2 or e <> 2 then raise exception 'T4 FAIL: devices=%, export=%', n, e; end if;
  raise notice 'T4 PASS: service_role sees devices=% export=%', n, e;
end $$;

-- T5 撤銷流程：pending 立刻退出匯出；revoked 不可復活
update public.devices
   set status = 'revocation_pending', revocation_requested_at = now(), revoked_by = 'test'
 where token_id = 'tok_fakewin01';
do $$
declare e int;
begin
  select count(*) into e from public.caddy_allowlist_export where token_id = 'tok_fakewin01';
  if e <> 0 then raise exception 'T5a FAIL: pending token still exported'; end if;
  raise notice 'T5a PASS: revocation_pending token removed from caddy_allowlist_export';
end $$;
update public.devices set status = 'revoked', revoked_at = now() where token_id = 'tok_fakewin01';
do $$
begin
  update public.devices set status = 'active', revoked_at = null where token_id = 'tok_fakewin01';
  raise exception 'T5b FAIL: revoked token reactivated';
exception when raise_exception then
  if sqlerrm like 'T5b FAIL%' then raise; end if;
  raise notice 'T5b PASS: revoked -> active rejected (%)', sqlerrm;
end $$;

-- T6 audit_log：service_role 可新增，不可改／刪
insert into public.audit_log (group_id, actor_type, actor_id, action, target_table, target_id)
values ('group-a', 'operator', 'test', 'device.revoke.applied', 'devices', 'tok_fakewin01');
do $$
begin
  update public.audit_log set action = 'x';
  raise exception 'T6a FAIL: service_role updated audit_log';
exception when insufficient_privilege then
  raise notice 'T6a PASS: service_role update audit_log -> permission denied';
end $$;
do $$
begin
  delete from public.audit_log;
  raise exception 'T6b FAIL: service_role deleted audit_log';
exception when insufficient_privilege then
  raise notice 'T6b PASS: service_role delete audit_log -> permission denied';
end $$;

-- T7 HubClock 期限不變量：question 必須 +24h；action 未 presented 不能有 deadline
do $$
begin
  insert into public.hub_clock_requests (group_id, root_mail_id, recipient_session, kind, root_created_at, deadline_at)
  values ('group-a', 1, 'win-s1', 'question', '2026-12-01T00:00Z', '2026-12-01T12:00Z');
  raise exception 'T7a FAIL: wrong question deadline accepted';
exception when check_violation then
  raise notice 'T7a PASS: question deadline != created+24h rejected';
end $$;
insert into public.hub_clock_requests (group_id, root_mail_id, recipient_session, kind, root_created_at, deadline_at)
values ('group-a', 2, 'win-s1', 'question', '2026-12-01T00:00Z', '2026-12-02T00:00Z');
do $$
begin
  insert into public.hub_clock_requests (group_id, root_mail_id, recipient_session, kind, root_created_at, deadline_at)
  values ('group-a', 3, 'win-s1', 'action', '2026-12-01T00:00Z', '2026-12-01T00:30Z');
  raise exception 'T7b FAIL: action deadline without presented accepted';
exception when check_violation then
  raise notice 'T7b PASS: action deadline before presented rejected';
end $$;
reset role;

-- T8 已撤銷的 anon／authenticated 不在 caddy view 上有權限
set local role anon;
do $$
begin
  perform 1 from public.caddy_allowlist_export;
  raise exception 'T8 FAIL: anon read caddy_allowlist_export';
exception when insufficient_privilege then
  raise notice 'T8 PASS: anon select caddy_allowlist_export -> permission denied';
end $$;
reset role;

rollback;
\echo ALL RLS TESTS PASSED
