-- ============================================================================
-- H-05｜讓 hub_clock_* 表與 ops/lifecycle 的 Store 介面一致（上線批次換 DB 時不改邏輯）
-- ----------------------------------------------------------------------------
-- MVP 實作（ops/lifecycle/store-file.mjs）發現的落差：
--   1. 一個 root 對每位收件「agent」一筆；question 與尚未 presented 的 action 沒有 session
--      → 加 recipient_agent，recipient_session 改可空，唯一鍵改 (group, root, recipient_agent)。
--   2. 結果與稽核需要的欄位：requester、thread_id、decided_by、decision_mail_id、reason、
--      reclassified（收件端把 question 判成 action）、late_events（晚到／被拒的事件）。
--   3. 重複事件抑制：hub_clock_processed（consumer, message_id）。
-- ============================================================================

alter table public.hub_clock_requests
  add column recipient_agent  text,
  add column requester        text,
  add column thread_id        text,
  add column decided_by       text,
  add column decision_mail_id bigint,
  add column reason           text,
  add column reclassified     boolean not null default false,
  add column late_events      jsonb   not null default '[]'::jsonb;

-- 上線前此表一定是空的（MVP 用檔案）。有資料就停下，不猜 recipient_agent。
do $$
begin
  if exists (select 1 from public.hub_clock_requests) then
    raise exception 'hub_clock_requests must be empty before this migration; import MVP state with ops/lifecycle after it';
  end if;
end
$$;

alter table public.hub_clock_requests
  alter column recipient_agent set not null,
  alter column recipient_session drop not null,
  drop constraint hub_clock_requests_group_id_root_mail_id_recipient_session_key,
  add constraint hub_clock_requests_root_recipient_key unique (group_id, root_mail_id, recipient_agent),
  -- presented 一定綁 session（choice 只接受同一 session）
  add constraint hub_clock_presented_has_session check (presented_at is null or recipient_session is not null);

drop index if exists public.hub_clock_requests_session_idx;
create index hub_clock_requests_session_idx
  on public.hub_clock_requests (group_id, recipient_agent, recipient_session) where status = 'presented';

create table public.hub_clock_processed (
  consumer     text   not null,                 -- 例 group-a:<HubClock 產生的 agent 名稱>
  message_id   bigint not null,
  processed_at timestamptz not null default now(),
  primary key (consumer, message_id)
);
comment on table public.hub_clock_processed is '已套用的 Mail 訊息 ID；重送／重讀同一頁時不重複套用。';

alter table public.hub_clock_processed enable row level security;
revoke all on table public.hub_clock_processed from anon, authenticated;
grant select, insert, delete on table public.hub_clock_processed to service_role;
create policy "service_role manages hub_clock_processed" on public.hub_clock_processed
  as permissive for all to service_role using (true) with check (true);
