-- Group identity is enforced in server applications even for service_role (BYPASSRLS).
-- These constraints prevent inconsistent rows and allow identical agent names in separate Mail servers.
alter table public.groups drop constraint groups_id_check;
alter table public.groups add constraint groups_id_check check (id ~ '^[a-z][a-z0-9-]{1,62}$');
alter table public.members add constraint members_id_group_unique unique(id, group_id);
alter table public.devices add constraint devices_member_group_fk
  foreign key(member_id, group_id) references public.members(id, group_id);
alter table public.discord_notifications add constraint notifications_member_group_fk
  foreign key(member_id, group_id) references public.members(id, group_id);
alter table public.bridge_cursors drop constraint bridge_cursors_pkey;
alter table public.bridge_cursors add primary key(group_id, agent_name);
