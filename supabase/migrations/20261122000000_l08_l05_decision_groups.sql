-- Each Mail container allocates its own message IDs; decision identity is per group.
alter table public.decisions drop constraint decisions_draft_mail_id_key;
alter table public.decisions drop constraint decisions_draft_id_key;
alter table public.decisions add constraint decisions_group_mail_unique unique(group_id, draft_mail_id);
alter table public.decisions add constraint decisions_group_draft_unique unique(group_id, draft_id);
alter table public.decisions add constraint decisions_confirmer_group_fk
  foreign key(confirmed_by, group_id) references public.members(id, group_id);
