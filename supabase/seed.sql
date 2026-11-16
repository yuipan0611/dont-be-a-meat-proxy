-- ============================================================================
-- 假資料（seed）：A 組、維護者、Mac／Windows 兩台裝置
-- ----------------------------------------------------------------------------
-- 全部是假值：token_hash 是 sha256('FAKE-mac-token-do-not-use') 這類字串的雜湊，
-- 不對應任何真實 token；Discord ID 也是假的。正式環境不要跑 seed。
-- Supabase：`supabase db reset` 會在 migrations 後自動執行本檔（config.toml [db.seed]）。
-- ============================================================================

insert into public.groups (id, display_name, project_key, mail_hostname, bank_id)
values ('group-a', 'A 組', '/data/projects/group-a', 'hub.example.invalid', 'group-a');

insert into public.members (id, group_id, display_name, role)
values ('00000000-0000-4000-8000-0000000000a1', 'group-a', '維護者', 'owner');

insert into public.devices
  (id, member_id, group_id, label, platform, token_id, token_prefix, token_hash, allowed_agents)
values
  ('00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-0000000000a1', 'group-a',
   '維護者 / Mac / Claude Code', 'macos', 'tok_fakemac01', 'mph_fmac',
   encode(sha256(convert_to('FAKE-mac-token-do-not-use', 'UTF8')), 'hex'), '{BlueLake}'),
  ('00000000-0000-4000-8000-00000000d002', '00000000-0000-4000-8000-0000000000a1', 'group-a',
   '維護者 / Windows / Claude Code', 'windows', 'tok_fakewin01', 'mph_fwin',
   encode(sha256(convert_to('FAKE-windows-token-do-not-use', 'UTF8')), 'hex'), '{RedStone}');

insert into public.discord_links (member_id, guild_id, discord_user_id, last_interaction_id)
values ('00000000-0000-4000-8000-0000000000a1', '10000000' || '0000000001', '20000000' || '0000000001', 'fake-interaction-1');

insert into public.audit_log (group_id, actor_type, actor_id, action, target_table, target_id, details)
values
  ('group-a', 'operator', 'seed', 'device.issue', 'devices', 'tok_fakemac01',   '{"note":"seed, fake"}'),
  ('group-a', 'operator', 'seed', 'device.issue', 'devices', 'tok_fakewin01',   '{"note":"seed, fake"}');
