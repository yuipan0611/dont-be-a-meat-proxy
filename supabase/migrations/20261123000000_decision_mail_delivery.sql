-- Persist the chosen decision action BEFORE sending Mail. Status remains draft until its receipt.
-- Existing grants/RLS and the per-group unique identity continue to apply to these columns.
alter table public.decisions add column mail_action jsonb;
alter table public.decisions add column mail_message_id bigint check (mail_message_id > 0);
alter table public.decisions add constraint decisions_mail_action_shape check (
  mail_action is null or (
    jsonb_typeof(mail_action) = 'object' and
    mail_action ?& array['key','status','memberId','discordUserId','memberName','now','message'] and
    mail_action->>'status' in ('confirmed','rejected') and
    jsonb_typeof(mail_action->'message') = 'object'
  )
);
