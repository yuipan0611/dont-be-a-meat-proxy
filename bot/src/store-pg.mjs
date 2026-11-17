// store-pg.mjs — the bot's only DB access (hub database, hub_app → service_role, docs/08 §3).
// Every multi-row change is one transaction. Discord IDs stay strings (never JS numbers).

import pg from 'pg';

const NOTIF_COLS = `id, group_id, member_id, mail_id::int as mail_id, recipient_agent, label, sender, subject, summary,
  to_char(mail_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as mail_created_at, state`;

const DECISION_COLS = `id, group_id, draft_mail_id::int as draft_mail_id, draft_id, author_agent, subject, summary, text,
  status, version, confirmed_by, confirmed_by_discord_id, confirmed_by_name,
  to_char(confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as confirmed_at,
  decision_reason, discord_message_id, reminder_sent,
  to_char(reminder_sent_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as reminder_sent_at,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at`;

export function createPgStore({ pool, groupId: boundGroup = 'group-a' }) {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(boundGroup)) throw new Error('invalid group_id');
  const scope = "'" + boundGroup + "'"; // restricted identifier above; never a caller-controlled SQL fragment
  const requireGroup = (id) => { if (id !== boundGroup) throw new Error('Group boundary'); };

  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query('begin');
      const r = await fn(c);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  const q = (text, values) => pool.query(text, values);

  async function audit({ groupId = null, actorType, actorId, action, targetTable = null, targetId = null, requestId = null, details = {} }, c = pool) {
    // Anonymous refusals belong to this bot instance; explicit foreign groups still fail below.
    groupId ??= boundGroup;
    requireGroup(groupId);
    await c.query(
      `insert into public.audit_log (group_id, actor_type, actor_id, action, target_table, target_id, request_id, details)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [groupId, actorType, actorId, action, targetTable, targetId, requestId, details],
    );
  }

  return {
    audit,

    async findMemberByDiscord(guildId, discordUserId) {
      const r = await q(
        `select m.id as member_id, m.group_id, m.display_name, m.role
           from public.discord_links l join public.members m on m.id = l.member_id
          where m.group_id = ${scope} and l.guild_id = $1 and l.discord_user_id = $2 and l.status = 'active' and m.status = 'active'`,
        [guildId, discordUserId],
      );
      const m = r.rows[0];
      return m ? { memberId: m.member_id, groupId: m.group_id, displayName: m.display_name, role: m.role } : null;
    },

    async ownerDiscordIds(groupId) {
      if (groupId !== boundGroup) return [];
      const r = await q(
        `select l.discord_user_id from public.members m join public.discord_links l on l.member_id = m.id and l.status = 'active'
          where m.group_id = $1 and m.role = 'owner' and m.status = 'active'`, [groupId]);
      return r.rows.map((x) => x.discord_user_id);
    },

    async issueDevice({ memberId, groupId, label, platform, tokenId, tokenPrefix, tokenHash, actorId, requestId }) {
      requireGroup(groupId);
      await tx(async (c) => {
        await c.query(
          `insert into public.devices (member_id, group_id, label, platform, token_id, token_prefix, token_hash)
           values ($1,$2,$3,$4,$5,$6,$7)`, [memberId, groupId, label, platform, tokenId, tokenPrefix, tokenHash]);
        await audit({ groupId, actorType: 'bot', actorId, action: 'device.issue.request', targetTable: 'devices', targetId: tokenId, requestId, details: { platform, token_prefix: tokenPrefix } }, c);
      });
    },

    async requestRevocation({ tokenId, memberId, actorId, reason, requestId }) {
      return tx(async (c) => {
        const r = await c.query(
          `update public.devices set status = 'revocation_pending', revocation_requested_at = now(), revoked_by = $3, revoke_reason = $4
            where group_id = ${scope} and token_id = $1 and member_id = $2 and status = 'active' returning group_id`, [tokenId, memberId, actorId, reason]);
        if (!r.rowCount) return false;
        await audit({ groupId: r.rows[0].group_id, actorType: 'bot', actorId, action: 'device.revoke.request', targetTable: 'devices', targetId: tokenId, requestId, details: { reason } }, c);
        return true;
      });
    },

    async completeRevocation({ tokenId, actorId, requestId, configRevision }) {
      await tx(async (c) => {
        const r = await c.query(
          `update public.devices set status = 'revoked', revoked_at = now(), config_revision = coalesce($2, config_revision)
            where group_id = ${scope} and token_id = $1 and status = 'revocation_pending' returning group_id`, [tokenId, configRevision]);
        if (r.rowCount) await audit({ groupId: r.rows[0].group_id, actorType: 'bot', actorId, action: 'device.revoke.applied', targetTable: 'devices', targetId: tokenId, requestId, details: { config_revision: configRevision } }, c);
      });
    },

    async watchedAgents() {
      const r = await q(
        `select a.agent_name, d.group_id, array_agg(distinct d.member_id::text) as member_ids
           from public.devices d
           join public.members m on m.id = d.member_id and m.status = 'active'
           join public.discord_links l on l.member_id = m.id and l.status = 'active'
           cross join lateral unnest(d.allowed_agents) as a(agent_name)
          where d.group_id = ${scope} and m.group_id = d.group_id and d.status = 'active'
          group by a.agent_name, d.group_id order by a.agent_name`);
      return r.rows.map((x) => ({ agentName: x.agent_name, groupId: x.group_id, memberIds: x.member_ids }));
    },

    async getCursor(agentName) {
      const r = await q(`select cursor from public.bridge_cursors where group_id = ${scope} and agent_name = $1`, [agentName]);
      return r.rowCount ? Number(r.rows[0].cursor) : null;
    },

    async commitIngest({ agentName, groupId, cursor, rows }) {
      requireGroup(groupId);
      for (const row of rows) requireGroup(row.groupId);
      return tx(async (c) => {
        let inserted = 0;
        for (const n of rows) {
          const r = await c.query(
            `insert into public.discord_notifications
               (group_id, member_id, mail_id, recipient_agent, label, sender, subject, summary, mail_created_at, state)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (member_id, mail_id) do nothing`,
            [n.groupId, n.memberId, n.mailId, n.recipientAgent, n.label, n.sender, n.subject, n.summary, n.mailCreatedAt, n.state]);
          inserted += r.rowCount;
          if (n.label?.startsWith('決策') || n.isDecision) {
            await c.query(
              `insert into public.decisions
                 (group_id, draft_mail_id, draft_id, author_agent, subject, summary, text, status, created_at)
               values ($1, $2, $3, $4, $5, $6, $7, 'draft', coalesce($8::timestamptz, now()))
               on conflict (group_id, draft_mail_id) do nothing`,
              [n.groupId, n.mailId, `dec_${n.mailId}`, n.sender, n.subject ?? '', n.summary ?? '', n.text ?? n.summary ?? '', n.mailCreatedAt]);
          }
        }
        await c.query(
          `insert into public.bridge_cursors (agent_name, group_id, cursor) values ($1,$2,$3)
           on conflict (group_id, agent_name) do update set cursor = greatest(public.bridge_cursors.cursor, excluded.cursor)`,
          [agentName, groupId, cursor]);
        return inserted;
      });
    },

    async membersWithWork() {
      const r = await q(
        `select distinct n.member_id, l.discord_user_id from public.discord_notifications n
           join public.discord_links l on l.member_id = n.member_id and l.status = 'active'
          where n.group_id = ${scope} and n.state in ('pending','held','failed')`);
      return r.rows.map((x) => ({ memberId: x.member_id, discordUserId: x.discord_user_id }));
    },

    async getPresence(memberId) {
      const r = await q(`select p.status from public.discord_presence p join public.members m on m.id = p.member_id where m.group_id = ${scope} and p.member_id = $1`, [memberId]);
      return r.rowCount ? r.rows[0].status : null;
    },

    async setPresenceByDiscord(guildId, discordUserId, status) {
      await q(
        `insert into public.discord_presence (member_id, status)
         select l.member_id, $3 from public.discord_links l join public.members m on m.id = l.member_id where m.group_id = ${scope} and l.guild_id = $1 and l.discord_user_id = $2 and l.status = 'active'
         on conflict (member_id) do update set status = excluded.status`, [guildId, discordUserId, status]);
    },

    async holdPending(memberId) {
      const r = await q(`update public.discord_notifications set state = 'held' where group_id = ${scope} and member_id = $1 and state = 'pending'`, [memberId]);
      return r.rowCount;
    },

    async listBacklog(memberId) {
      const r = await q(`select ${NOTIF_COLS} from public.discord_notifications where group_id = ${scope} and member_id = $1 and state in ('held','failed') order by mail_id`, [memberId]);
      return r.rows;
    },

    async markDigested(ids, discordMessageId) {
      if (!ids.length) return;
      await q(
        `update public.discord_notifications set state = 'digested', digest_id = (select min(x) from unnest($1::bigint[]) x), discord_message_id = $2
          where group_id = ${scope} and id = any($1::bigint[]) and state in ('held','failed')`, [ids, discordMessageId]);
    },

    async listPending(memberId) {
      const r = await q(`select ${NOTIF_COLS} from public.discord_notifications where group_id = ${scope} and member_id = $1 and state = 'pending' order by mail_id`, [memberId]);
      return r.rows;
    },

    async markNotification(id, state, { error = null, discordMessageId = null } = {}) {
      await q(
        `update public.discord_notifications set state = $2, attempts = attempts + 1, last_error = $3, discord_message_id = coalesce($4, discord_message_id)
          where group_id = ${scope} and id = $1 and state = 'pending'`, [id, state, error, discordMessageId]);
    },

    async recentItems(groupId, limit) {
      if (groupId !== boundGroup) return [];
      const r = await q(
        `select distinct on (n.mail_id)
           n.id, n.group_id, n.member_id, n.mail_id::int as mail_id, n.recipient_agent, n.label, n.sender, n.subject, n.summary,
           to_char(n.mail_created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as mail_created_at, n.state,
           case
             when d.status = 'confirmed' then '已確認'
             when d.status = 'rejected' then '已駁回'
             when d.status = 'draft' then '草稿'
             when n.label like '決策%' then '草稿'
             else null
           end as decision_status
          from public.discord_notifications n
          left join public.decisions d on d.group_id = n.group_id and d.draft_mail_id = n.mail_id
         where n.group_id = $1
         order by n.mail_id desc, n.id limit $2`, [groupId, limit]);
      return r.rows;
    },

    async recordDecisionDraft({ groupId, draftMailId, draftId, authorAgent, subject = '', summary = '', text = '', createdAt = null }) {
      requireGroup(groupId);
      const dId = draftId ?? `dec_${draftMailId}`;
      const r = await q(
        `insert into public.decisions (group_id, draft_mail_id, draft_id, author_agent, subject, summary, text, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
         on conflict (group_id, draft_mail_id) do update set updated_at = now()
         returning ${DECISION_COLS}`,
        [groupId, draftMailId, dId, authorAgent, subject, summary, text, createdAt]
      );
      return r.rows[0];
    },

    async getDecisionByMailId(draftMailId) {
      const r = await q(`select ${DECISION_COLS} from public.decisions where group_id = ${scope} and draft_mail_id = $1`, [draftMailId]);
      return r.rows[0] ?? null;
    },

    async getDecisionByDraftId(draftId) {
      const r = await q(`select ${DECISION_COLS} from public.decisions where group_id = ${scope} and (draft_id = $1 or draft_mail_id::text = $1)`, [draftId]);
      return r.rows[0] ?? null;
    },

    async listDecisions(groupId, { status, limit = 50 } = {}) {
      if (groupId !== boundGroup) return [];
      if (status) {
        const r = await q(
          `select ${DECISION_COLS} from public.decisions where group_id = $1 and status = $2 order by created_at desc, id desc limit $3`,
          [groupId, status, limit]
        );
        return r.rows;
      }
      const r = await q(
        `select ${DECISION_COLS} from public.decisions where group_id = $1 order by created_at desc, id desc limit $2`,
        [groupId, limit]
      );
      return r.rows;
    },

    async updateDecisionStatus({ draftMailId, status, memberId, discordUserId, memberName, reason = null, now = null }) {
      const r = await q(
        `update public.decisions
            set status = $2,
                confirmed_by = $3,
                confirmed_by_discord_id = $4,
                confirmed_by_name = $5,
                confirmed_at = coalesce($6::timestamptz, now()),
                decision_reason = $7,
                version = version + 1,
                updated_at = coalesce($6::timestamptz, now())
          where group_id = ${scope} and draft_mail_id = $1 and status = 'draft'
            and exists (select 1 from public.members m where m.id = $3 and m.group_id = ${scope} and m.status = 'active')
          returning ${DECISION_COLS}`,
        [draftMailId, status, memberId, discordUserId, memberName, now, reason]
      );
      return r.rows[0] ?? null;
    },

    async listDueDraftReminders(nowMs, timeoutMs = 7 * 24 * 60 * 60 * 1000) {
      const cutoff = new Date(nowMs - timeoutMs).toISOString();
      const r = await q(
        `select ${DECISION_COLS} from public.decisions
          where group_id = ${scope} and status = 'draft' and not reminder_sent and created_at <= $1::timestamptz
          order by created_at asc`,
        [cutoff]
      );
      return r.rows;
    },

    async markDraftReminderSent(draftMailId, now = null) {
      const r = await q(
        `update public.decisions
            set reminder_sent = true,
                reminder_sent_at = coalesce($2::timestamptz, now()),
                updated_at = coalesce($2::timestamptz, now())
          where group_id = ${scope} and draft_mail_id = $1
          returning ${DECISION_COLS}`,
        [draftMailId, now]
      );
      return r.rows[0] ?? null;
    },

    async itemBelongsToGroup(groupId, mailId) {
      if (groupId !== boundGroup) return false;
      const r = await q('select 1 from public.discord_notifications where group_id = $1 and mail_id = $2 limit 1', [groupId, mailId]);
      return r.rowCount > 0;
    },

    async reserveBudget({ groupId, day, estimateUsd, capUsd }) {
      requireGroup(groupId);
      return tx(async (c) => {
        await c.query(`insert into public.assistant_budget (group_id, day) values ($1,$2) on conflict do nothing`, [groupId, day]);
        const r = await c.query(
          `update public.assistant_budget set reserved_usd = reserved_usd + $3, calls = calls + 1
            where group_id = $1 and day = $2 and spent_usd + reserved_usd + $3 <= $4`, [groupId, day, estimateUsd, capUsd]);
        if (r.rowCount) return true;
        await c.query('update public.assistant_budget set rejected = rejected + 1 where group_id = $1 and day = $2', [groupId, day]);
        return false;
      });
    },

    async settleBudget({ groupId, day, reservedUsd, actualUsd }) {
      requireGroup(groupId);
      await q(
        `update public.assistant_budget set reserved_usd = greatest(0, reserved_usd - $3), spent_usd = spent_usd + $4
          where group_id = $1 and day = $2`, [groupId, day, reservedUsd, actualUsd]);
    },

    async markCapNotified(groupId, day) {
      requireGroup(groupId);
      const r = await q(
        `insert into public.assistant_budget (group_id, day, cap_notified) values ($1, $2, true)
          on conflict (group_id, day) do update set cap_notified = true
          where not assistant_budget.cap_notified`, [groupId, day]);
      return r.rowCount > 0;
    },

    async budgetRow(groupId, day) {
      if (groupId !== boundGroup) return null;
      const r = await q('select spent_usd::float8 as spent, reserved_usd::float8 as reserved, calls, rejected, cap_notified from public.assistant_budget where group_id = $1 and day = $2', [groupId, day]);
      return r.rows[0] ?? null;
    },
  };
}

/** Pool from a password FILE (Compose secret); the password never travels via env or argv. */
export async function createPool({ host, port = 5432, database = 'hub', user = 'hub_app', passwordFile, max = 3 }) {
  const { readFile } = await import('node:fs/promises');
  const password = (await readFile(passwordFile, 'utf8')).trim();
  return new pg.Pool({ host, port, database, user, password, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}
