-- ============================================================================
-- 相容 migration：只在「非 Supabase」的純 Postgres 上有作用
-- ----------------------------------------------------------------------------
-- 目的：讓後面的 migration 能原封不動在三種環境跑：
--   1. 我們 VPS 上 Hindsight 用的 pgvector Postgres（純 Postgres，沒有這三個 role）
--   2. Supabase 雲端（role 已存在 → 本檔每段都是 no-op）
--   3. Supabase 完整自架版（同上，role 由官方 image 建好 → no-op）
--
-- 屬性照 Supabase 慣例：
--   anon / authenticated：NOLOGIN NOINHERIT，經 RLS 限制
--   service_role：NOLOGIN NOINHERIT BYPASSRLS（「bypasses RLS, so keep it server-side」）
--   來源：https://supabase.com/docs/guides/database/postgres/roles
--         https://supabase.com/docs/guides/database/postgres/row-level-security
--         （查詢 2026-11-17）
--
-- 不在這裡建「可登入」的帳號與密碼（秘密不進 git）。純 Postgres 上由 operator 另建
-- login role 並 GRANT service_role，見 docs/08-data-layer-supabase.md §4。
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- 純 Postgres 預設 PUBLIC 可在 public schema 用物件；Supabase 上三個 role 本來就有 usage。
grant usage on schema public to anon, authenticated, service_role;
