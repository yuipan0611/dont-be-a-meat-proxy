-- ============================================================================
-- L-05｜決策：草稿→正式、確認/駁回紀錄、期限與 RLS
-- ----------------------------------------------------------------------------
-- 依據：SRS SR-DEC-01～05、§4.5 #12、TC-20；
--       docs/08 §1 的 RLS／grant 慣例（照 20261117000200 原樣做）。
-- 只新增表，不改既有表。bot 以 hub_app（service_role）連線。
-- ============================================================================

-- 決策表：以 Hub Mail message 為真相索引（draft_mail_id）
create table public.decisions (
  id                      bigint generated always as identity primary key,
  group_id                text not null references public.groups (id) on delete restrict,
  draft_mail_id           bigint not null unique,               -- Mail 伺服器 message ID（草稿 ID）
  draft_id                text not null unique,                -- 格式化草稿識別碼（例：dec_123）
  author_agent            text not null,                       -- 提出決策草稿的 agent
  subject                 text not null default '',
  summary                 text not null default '',
  text                    text not null default '',            -- 決策原文
  -- draft：草稿；confirmed：已確認（正式決策）；rejected：已駁回；vetoed：已否決〔S2+〕
  status                  text not null default 'draft'
                            check (status in ('draft', 'confirmed', 'rejected', 'vetoed')),
  version                 integer not null default 1 check (version >= 1),
  confirmed_by            uuid references public.members (id) on delete restrict,
  confirmed_by_discord_id text,
  confirmed_by_name       text,
  confirmed_at            timestamptz,
  decision_reason         text,
  discord_message_id      text,
  reminder_sent           boolean not null default false,
  reminder_sent_at        timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index decisions_group_status_idx on public.decisions (group_id, status);
create index decisions_reminder_idx on public.decisions (status, reminder_sent, created_at)
  where status = 'draft' and not reminder_sent;

comment on table public.decisions is
  'L-05 決策表。草稿先寫入 Hub Mail（draft_mail_id），確認後轉正式；確認/駁回記錄確認者與時間，按鈕只能用一次（SR-DEC-01～03）。';

create trigger decisions_set_updated_at before update on public.decisions
  for each row execute function public.set_updated_at();

-- RLS／grants：與 20261117000200 相同的四步
alter table public.decisions enable row level security;

revoke all on table public.decisions from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert, update, delete on table public.decisions to service_role;
grant usage, select on all sequences in schema public to service_role;

create policy "service_role manages decisions" on public.decisions
  as permissive for all to service_role using (true) with check (true);
