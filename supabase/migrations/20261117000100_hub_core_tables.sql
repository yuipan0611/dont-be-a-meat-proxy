-- ============================================================================
-- T15｜Hub 自有資料（上線批次 2026-11-30 起生效；MVP 仍用檔案）
-- ----------------------------------------------------------------------------
-- 依據：docs/05-sds.md「資料」表（group / principal / ops SQLite requests / audit）、
--       API-05（/connect、/revoke、TokenApplier）、API-06（HubClock 計時）。
-- 慣例：Supabase migration（supabase/migrations/<timestamp>_<name>.sql）、
--       public schema、每張表開 RLS、只授權 service_role。
--   https://supabase.com/docs/guides/deployment/database-migrations
--   https://supabase.com/docs/guides/database/postgres/row-level-security
--   （查詢 2026-11-17）
--
-- 存取模型：成員不直接連 DB（沒有 Supabase Auth 登入），所有讀寫都經 bot／
-- bank-proxy／ops 等伺服器元件，以 service_role 身分進行。anon／authenticated
-- 不授任何表權限，RLS 也沒有給它們的 policy → 兩層都拒絕。
-- 不用 auth.uid()／auth schema，確保純 Postgres 也能跑。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 共用：updated_at 觸發器（search_path 固定為空，照 Supabase advisor 建議）
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- groups：一組一個 Mail 容器／project_key／Hindsight bank
-- ---------------------------------------------------------------------------
create table public.groups (
  id            text primary key check (id ~ '^group-[a-z]$'),
  display_name  text not null,
  project_key   text not null unique,           -- 例 /data/projects/group-a（兩台裝置共用）
  mail_hostname text not null,                  -- 例 hub.example.invalid
  bank_id       text unique,                    -- Hindsight bank，L 起才填
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.groups is '組別。SDS group：group_id、固定 project_key、Mail hostname、L 的 bank_id。';

-- ---------------------------------------------------------------------------
-- members：人（S1 只有 維護者；S2 由成員名單核發）
-- ---------------------------------------------------------------------------
create table public.members (
  id           uuid primary key default gen_random_uuid(),
  group_id     text not null references public.groups (id) on delete restrict,
  display_name text not null,
  role         text not null default 'member' check (role in ('owner', 'member')),
  status       text not null default 'active' check (status in ('active', 'removed')),
  created_at   timestamptz not null default now(),
  removed_at   timestamptz,
  updated_at   timestamptz not null default now(),
  constraint members_removed_at_matches_status
    check ((status = 'removed') = (removed_at is not null)),
  unique (group_id, display_name)
);
create index members_group_id_idx on public.members (group_id);
comment on table public.members is '組員。Discord 身分放 discord_links，不放這裡。';

-- ---------------------------------------------------------------------------
-- devices：每裝置一把入口 token（維護者 已定）。只存 hash＋前綴，不存原值。
-- ---------------------------------------------------------------------------
create table public.devices (
  id                       uuid primary key default gen_random_uuid(),
  member_id                uuid not null references public.members (id) on delete restrict,
  group_id                 text not null references public.groups (id) on delete restrict,
  label                    text not null,                       -- 顯示用：維護者 / Mac / Claude Code
  platform                 text not null check (platform in ('macos', 'windows', 'linux')),
  token_id                 text not null unique check (token_id ~ '^tok_[a-z0-9]{8,32}$'),
  token_prefix             text not null check (char_length(token_prefix) between 4 and 16),
  token_hash               text not null unique check (token_hash ~ '^[0-9a-f]{64}$'), -- SHA-256 hex
  allowed_agents           text[] not null default '{}',        -- 例 {BlueLake}
  status                   text not null default 'active'
                             check (status in ('active', 'revocation_pending', 'revoked')),
  issued_at                timestamptz not null default now(),
  revocation_requested_at  timestamptz,
  revoked_at               timestamptz,
  revoked_by               text,
  revoke_reason            text,
  config_revision          bigint,                              -- 最後套用到 Caddy 的 revision
  updated_at               timestamptz not null default now(),
  constraint devices_revoked_at_matches_status
    check ((status = 'revoked') = (revoked_at is not null)),
  constraint devices_pending_has_request_time
    check (status = 'active' or revocation_requested_at is not null)
);
create index devices_member_id_idx on public.devices (member_id);
create index devices_group_status_idx on public.devices (group_id, status);
comment on table public.devices is
  '裝置 token registry。DB 是權威；Caddy allowlist 由此匯出。token 原值只在發放當下給使用者，DB 只留 SHA-256 hex＋前綴。';
comment on column public.devices.token_hash is
  'SHA-256(token) 小寫 hex。token 為 ≥256 bit 隨機值，故不需慢雜湊（工程判斷，見 docs/08）。';

-- 不變量：撤銷不可復活、hash 不可改（輪替＝撤舊＋新增一列），只能往前走。
create or replace function public.devices_guard_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.token_hash <> old.token_hash or new.token_id <> old.token_id then
    raise exception 'devices: token_id/token_hash are immutable; rotate by revoking and inserting a new row';
  end if;
  if old.status = 'revoked' and new.status <> 'revoked' then
    raise exception 'devices: revoked token % cannot be reactivated', old.token_id;
  end if;
  if old.status = 'revocation_pending' and new.status = 'active' then
    raise exception 'devices: revocation of % is pending; it cannot be rolled back to active', old.token_id;
  end if;
  return new;
end;
$$;
revoke execute on function public.devices_guard_transition() from public, anon, authenticated;

create trigger devices_guard_transition
  before update on public.devices
  for each row execute function public.devices_guard_transition();

-- Caddy 匯出用：只列「現在應該放行」的 token。security_invoker 照 Supabase 對 view 的建議。
create view public.caddy_allowlist_export
with (security_invoker = true)
as
select d.group_id, d.token_id, d.token_prefix, d.token_hash, d.label, d.allowed_agents
from public.devices d
join public.members m on m.id = d.member_id
where d.status = 'active'
  and m.status = 'active';
comment on view public.caddy_allowlist_export is
  'render-caddy 的輸入：status=active 且成員仍在的裝置。revocation_pending 已排除。';

-- ---------------------------------------------------------------------------
-- discord_links：/connect 綁定（Discord user ↔ member）
-- ---------------------------------------------------------------------------
create table public.discord_links (
  id                  uuid primary key default gen_random_uuid(),
  member_id           uuid not null references public.members (id) on delete restrict,
  guild_id            text not null check (guild_id ~ '^[0-9]{17,20}$'),
  discord_user_id     text not null check (discord_user_id ~ '^[0-9]{17,20}$'), -- 字串，不轉 JS number
  status              text not null default 'active' check (status in ('active', 'unlinked')),
  linked_at           timestamptz not null default now(),
  unlinked_at         timestamptz,
  last_interaction_id text,
  updated_at          timestamptz not null default now(),
  constraint discord_links_unlinked_at_matches_status
    check ((status = 'unlinked') = (unlinked_at is not null))
);
create unique index discord_links_active_user_uidx
  on public.discord_links (guild_id, discord_user_id) where status = 'active';
create unique index discord_links_active_member_uidx
  on public.discord_links (guild_id, member_id) where status = 'active';
comment on table public.discord_links is '/connect 綁定。同 guild 一個 Discord 帳號同時只綁一位成員。';

-- ---------------------------------------------------------------------------
-- HubClock 計時狀態（取代 MVP 的 ops SQLite／狀態檔；SDS API-06）
-- ---------------------------------------------------------------------------
create table public.hub_clock_requests (
  id                 bigint generated always as identity primary key,
  group_id           text not null references public.groups (id) on delete restrict,
  root_mail_id       bigint not null,                -- Mail 伺服器 ID
  recipient_session  text not null,
  kind               text not null check (kind in ('question', 'action')),
  status             text not null default 'pending' check (status in
                       ('pending', 'presented', 'answered', 'unanswered',
                        'approved', 'rejected', 'expired', 'invalidated')),
  root_created_at    timestamptz not null,           -- Mail 伺服器 created_ts
  presented_mail_id  bigint,
  presented_at       timestamptz,                    -- presented 事件的伺服器時間 = t0
  deadline_at        timestamptz,
  resolved_at        timestamptz,
  result_mail_id     bigint,                         -- 正式結果寫回 Mail 後的 ID
  version            integer not null default 0,     -- compare-and-set
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (group_id, root_mail_id, recipient_session),
  -- question 只能 pending→answered|unanswered|invalidated；action 走 presented→approved|rejected|expired|invalidated
  constraint hub_clock_status_matches_kind check (
    (kind = 'question' and status in ('pending', 'answered', 'unanswered', 'invalidated'))
    or (kind = 'action' and status in ('pending', 'presented', 'approved', 'rejected', 'expired', 'invalidated'))
  ),
  -- question：deadline = 根訊息 + 24 h（SRS §4.4）
  constraint hub_clock_question_deadline check (
    kind <> 'question' or deadline_at = root_created_at + interval '24 hours'
  ),
  -- action：離線期間沒有 presented 就不開始 30 分鐘；presented 後 deadline = t0 + 30 min
  constraint hub_clock_action_deadline check (
    kind <> 'action'
    or (presented_at is null and deadline_at is null)
    or (presented_at is not null and deadline_at = presented_at + interval '30 minutes')
  ),
  constraint hub_clock_resolved_matches_status check (
    (status in ('pending', 'presented')) = (resolved_at is null)
  )
);
create index hub_clock_requests_open_deadline_idx
  on public.hub_clock_requests (deadline_at) where status in ('pending', 'presented');
create index hub_clock_requests_session_idx
  on public.hub_clock_requests (group_id, recipient_session) where status in ('pending', 'presented');
comment on table public.hub_clock_requests is
  'HubClock 的 question／action 計時。正式結果仍寫 Mail，這裡只是排程狀態（SDS API-06）。';

create table public.hub_clock_outbox (
  event_key       text primary key,                  -- 固定 idempotency key
  request_id      bigint not null references public.hub_clock_requests (id) on delete restrict,
  target          text not null default 'mail' check (target in ('mail', 'discord')),
  payload         jsonb not null,
  state           text not null default 'pending' check (state in ('pending', 'sent', 'failed')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_try_at     timestamptz not null default now(),
  result_mail_id  bigint,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint hub_clock_outbox_sent_has_result check (state <> 'sent' or target <> 'mail' or result_mail_id is not null)
);
create index hub_clock_outbox_due_idx on public.hub_clock_outbox (next_try_at) where state = 'pending';

create table public.hub_clock_cursors (
  consumer    text primary key,                       -- 例 group-a:HubClock
  group_id    text not null references public.groups (id) on delete restrict,
  cursor      text not null,                          -- fetch_inbox_events 的 cursor（不透明字串）
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- audit_log：append-only 稽核（token 核發／撤銷、/connect、決策、HubClock 結果）
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id           bigint generated always as identity primary key,
  occurred_at  timestamptz not null default now(),
  group_id     text references public.groups (id) on delete restrict,
  actor_type   text not null check (actor_type in ('operator', 'bot', 'ops', 'member', 'system')),
  actor_id     text not null,                          -- token_id／discord_user_id／'HubClock' 等，不放秘密
  action       text not null,                          -- 例 device.issue、device.revoke.request、device.revoke.applied
  target_table text,
  target_id    text,
  request_id   text,                                   -- TokenApplier request_id／Discord interaction ID
  details      jsonb not null default '{}'::jsonb      -- 禁放 token 原值／Authorization／完整 body
);
create index audit_log_target_idx on public.audit_log (target_table, target_id);
create index audit_log_occurred_at_idx on public.audit_log (occurred_at);
comment on table public.audit_log is
  'append-only。UPDATE 一律禁止；DELETE 只允許 2027-03-31 到期清除（session 設 hub.audit_purge=on）。';

create or replace function public.audit_log_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('hub.audit_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'audit_log is append-only (% not allowed)', tg_op;
end;
$$;
revoke execute on function public.audit_log_append_only() from public, anon, authenticated;

create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.audit_log_append_only();

-- ---------------------------------------------------------------------------
-- updated_at 觸發器
-- ---------------------------------------------------------------------------
create trigger groups_set_updated_at before update on public.groups
  for each row execute function public.set_updated_at();
create trigger members_set_updated_at before update on public.members
  for each row execute function public.set_updated_at();
create trigger devices_set_updated_at before update on public.devices
  for each row execute function public.set_updated_at();
create trigger discord_links_set_updated_at before update on public.discord_links
  for each row execute function public.set_updated_at();
create trigger hub_clock_requests_set_updated_at before update on public.hub_clock_requests
  for each row execute function public.set_updated_at();
create trigger hub_clock_outbox_set_updated_at before update on public.hub_clock_outbox
  for each row execute function public.set_updated_at();
create trigger hub_clock_cursors_set_updated_at before update on public.hub_clock_cursors
  for each row execute function public.set_updated_at();
