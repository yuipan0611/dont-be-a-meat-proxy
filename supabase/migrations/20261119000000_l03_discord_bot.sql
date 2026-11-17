-- ============================================================================
-- L-03｜Discord bot：通知 outbox、bridge cursor、在線狀態、/status 每日額度
-- ----------------------------------------------------------------------------
-- 依據：SRS SR-NTF-01～04、SR-AST-04、§4.5 #3／#9；SDS API-05「通知」、GAP-18（Haiku 5.5、
--       每日共用 0.50 USD）；docs/08 §1 的 RLS／grant 慣例（照 20261117000200 原樣做）。
-- 只新增表，不改既有表。bot 以 hub_app（service_role）連線。
-- ============================================================================

-- bridge 讀每個被監看 agent 的 fetch_inbox_events cursor（不標已讀）
create table public.bridge_cursors (
  agent_name  text primary key,
  group_id    text not null references public.groups (id) on delete restrict,
  cursor      bigint not null default 0 check (cursor >= 0),
  updated_at  timestamptz not null default now()
);
comment on table public.bridge_cursors is
  'L-03 bridge：每個 agent 的 inbox event cursor；與通知列同一交易前進（不漏、不重複）。';

-- 通知 outbox：一則 Mail × 一位成員一列。只在 Mail 已保存後由 bridge 產生（SR-NTF-01）。
create table public.discord_notifications (
  id               bigint generated always as identity primary key,
  group_id         text not null references public.groups (id) on delete restrict,
  member_id        uuid not null references public.members (id) on delete restrict,
  mail_id          bigint not null,                 -- Mail 伺服器 message ID
  recipient_agent  text not null,
  label            text not null,                   -- 類型，例「交接」「HubClock 通知：已逾時」
  sender           text not null,
  subject          text not null default '',
  summary          text not null check (char_length(summary) <= 200),  -- §4.5 #9
  mail_created_at  timestamptz not null,
  -- pending：待送；sent：已送出；failed：送出失敗（不逐則重送，併入彙總）；
  -- held：成員離線或 bot 停機積壓（併入彙總）；digested：已包含在一則彙總裡；unknown：送出結果不明
  state            text not null default 'pending'
                     check (state in ('pending', 'sent', 'failed', 'held', 'digested', 'unknown')),
  attempts         integer not null default 0 check (attempts >= 0),
  last_error       text,
  discord_message_id text,
  digest_id        bigint,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (member_id, mail_id)
);
create index discord_notifications_due_idx on public.discord_notifications (member_id, state)
  where state in ('pending', 'failed', 'held');
comment on table public.discord_notifications is
  'L-03 通知 outbox。離線不逐則補發：held／failed 在成員回來時併成一則「你不在時有 N 則」（SRS §4.5 #9）。';

-- 成員在 Discord 的在線狀態（presence intent 開時才有資料；沒有就視為在線）
create table public.discord_presence (
  member_id   uuid primary key references public.members (id) on delete restrict,
  status      text not null check (status in ('online', 'idle', 'dnd', 'offline')),
  updated_at  timestamptz not null default now()
);

-- /status 每日額度：Asia/Taipei 日界；先預留最壞費用，呼叫後以實際 usage 結算（SR-AST-04）
create table public.assistant_budget (
  group_id      text not null references public.groups (id) on delete restrict,
  day           date not null,                    -- Asia/Taipei 日期
  spent_usd     numeric(12, 6) not null default 0 check (spent_usd >= 0),
  reserved_usd  numeric(12, 6) not null default 0 check (reserved_usd >= 0),
  calls         integer not null default 0 check (calls >= 0),
  rejected      integer not null default 0 check (rejected >= 0),
  cap_notified  boolean not null default false,
  updated_at    timestamptz not null default now(),
  primary key (group_id, day)
);
comment on table public.assistant_budget is
  'L-03 /status 用量。spent+reserved+本次預估 > 上限 → E-QUOTA，不呼叫 LLM。';

create trigger bridge_cursors_set_updated_at before update on public.bridge_cursors
  for each row execute function public.set_updated_at();
create trigger discord_notifications_set_updated_at before update on public.discord_notifications
  for each row execute function public.set_updated_at();
create trigger discord_presence_set_updated_at before update on public.discord_presence
  for each row execute function public.set_updated_at();
create trigger assistant_budget_set_updated_at before update on public.assistant_budget
  for each row execute function public.set_updated_at();

-- RLS／grants：與 20261117000200 相同的四步
alter table public.bridge_cursors        enable row level security;
alter table public.discord_notifications enable row level security;
alter table public.discord_presence      enable row level security;
alter table public.assistant_budget      enable row level security;

revoke all on table
  public.bridge_cursors, public.discord_notifications, public.discord_presence, public.assistant_budget
from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert, update, delete on table
  public.bridge_cursors, public.discord_notifications, public.discord_presence, public.assistant_budget
to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy "service_role manages bridge_cursors" on public.bridge_cursors
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages discord_notifications" on public.discord_notifications
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages discord_presence" on public.discord_presence
  as permissive for all to service_role using (true) with check (true);
create policy "service_role manages assistant_budget" on public.assistant_budget
  as permissive for all to service_role using (true) with check (true);
