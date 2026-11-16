-- ============================================================================
-- T15｜RLS 與權限
-- ----------------------------------------------------------------------------
-- Supabase 文件（查詢 2026-11-17）：
--   * 開 RLS 後，publishable（anon）key 在建立 policy 前讀不到任何資料。
--   * 「Adding policies doesn't take those grants back」→ grant 要另外收回。
--   * 舊專案 public 新表預設對三個 role 全授權；新專案／新 CLI 預設不自動公開。
--   https://supabase.com/docs/guides/database/postgres/row-level-security
-- 為了在「舊雲端專案」「新雲端專案」「純 Postgres」三種預設下結果一致，
-- 這裡一律：revoke anon/authenticated → grant service_role → RLS → service_role policy。
-- service_role 有 BYPASSRLS，policy 仍明寫，方便審查與日後若改用非 bypass 角色。
-- ============================================================================

-- 1) 開 RLS（不加 FORCE：表 owner＝migration 角色 postgres 照 PG 規則不受 RLS，供 operator 維運）
alter table public.groups             enable row level security;
alter table public.members            enable row level security;
alter table public.devices            enable row level security;
alter table public.discord_links      enable row level security;
alter table public.hub_clock_requests enable row level security;
alter table public.hub_clock_outbox   enable row level security;
alter table public.hub_clock_cursors  enable row level security;
alter table public.audit_log          enable row level security;

-- 2) 收回 anon／authenticated 的一切表權限（包含 view 與 sequence）
revoke all on table
  public.groups, public.members, public.devices, public.discord_links,
  public.hub_clock_requests, public.hub_clock_outbox, public.hub_clock_cursors,
  public.audit_log, public.caddy_allowlist_export
from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 3) service_role：一般表 CRUD；audit_log 只能讀＋新增；view 只讀
grant select, insert, update, delete on table
  public.groups, public.members, public.devices, public.discord_links,
  public.hub_clock_requests, public.hub_clock_outbox, public.hub_clock_cursors
to service_role;
grant select, insert on table public.audit_log to service_role;
grant select on table public.caddy_allowlist_export to service_role;
grant usage, select on all sequences in schema public to service_role;

-- 4) Policies（只給 service_role；anon／authenticated 沒有任何 policy → RLS 預設拒絕）
create policy "service_role manages groups" on public.groups
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages members" on public.members
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages devices" on public.devices
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages discord_links" on public.discord_links
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages hub_clock_requests" on public.hub_clock_requests
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages hub_clock_outbox" on public.hub_clock_outbox
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages hub_clock_cursors" on public.hub_clock_cursors
  as permissive for all to service_role using (true) with check (true);

create policy "service_role reads audit_log" on public.audit_log
  as permissive for select to service_role using (true);
create policy "service_role appends audit_log" on public.audit_log
  as permissive for insert to service_role with check (true);
