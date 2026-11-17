// In-memory twin of src/store-pg.mjs for unit tests. test/store-pg.integration.test.mjs runs the
// same contract (test/helpers/store-contract.mjs) against both, so the twin cannot drift silently.

export function createMemoryStore({ groups = [], members = [], links = [], devices = [] } = {}) {
  const db = {
    groups: [...groups],
    members: members.map((m) => ({ role: 'member', status: 'active', ...m })),
    links: links.map((l) => ({ status: 'active', ...l })),
    devices: devices.map((d) => ({ status: 'active', allowed_agents: [], ...d })),
    audit: [], cursors: new Map(), notifs: [], presence: new Map(), budget: new Map(), decisions: [],
  };
  let nextId = 1;
  let nextDecId = 1;
  const activeLink = (memberId) => db.links.find((l) => l.member_id === memberId && l.status === 'active');
  const member = (id) => db.members.find((m) => m.id === id);

  return {
    db,
    async audit(e) { db.audit.push({ ...e }); },
    async findMemberByDiscord(guildId, userId) {
      const l = db.links.find((x) => x.guild_id === guildId && x.discord_user_id === userId && x.status === 'active');
      const m = l && member(l.member_id);
      return m && m.status === 'active' ? { memberId: m.id, groupId: m.group_id, displayName: m.display_name, role: m.role } : null;
    },
    async ownerDiscordIds(groupId) {
      return db.members.filter((m) => m.group_id === groupId && m.role === 'owner' && m.status === 'active')
        .map((m) => activeLink(m.id)?.discord_user_id).filter(Boolean);
    },
    async issueDevice(d) {
      if (db.devices.some((x) => x.token_id === d.tokenId || x.token_hash === d.tokenHash)) throw new Error('duplicate token');
      db.devices.push({ member_id: d.memberId, group_id: d.groupId, label: d.label, platform: d.platform, token_id: d.tokenId, token_prefix: d.tokenPrefix, token_hash: d.tokenHash, allowed_agents: [], status: 'active' });
      db.audit.push({ action: 'device.issue.request', targetId: d.tokenId, details: { platform: d.platform, token_prefix: d.tokenPrefix } });
    },
    async requestRevocation({ tokenId, memberId, reason }) {
      const d = db.devices.find((x) => x.token_id === tokenId && x.member_id === memberId && x.status === 'active');
      if (!d) return false;
      d.status = 'revocation_pending';
      db.audit.push({ action: 'device.revoke.request', targetId: tokenId, details: { reason } });
      return true;
    },
    async completeRevocation({ tokenId }) {
      const d = db.devices.find((x) => x.token_id === tokenId && x.status === 'revocation_pending');
      if (d) { d.status = 'revoked'; db.audit.push({ action: 'device.revoke.applied', targetId: tokenId }); }
    },
    async watchedAgents() {
      const map = new Map();
      for (const d of db.devices) {
        const m = member(d.member_id);
        if (d.status !== 'active' || !m || m.status !== 'active' || !activeLink(m.id)) continue;
        for (const a of d.allowed_agents) {
          const k = `${a}|${d.group_id}`;
          if (!map.has(k)) map.set(k, { agentName: a, groupId: d.group_id, memberIds: [] });
          if (!map.get(k).memberIds.includes(m.id)) map.get(k).memberIds.push(m.id);
        }
      }
      return [...map.values()].sort((a, b) => a.agentName.localeCompare(b.agentName));
    },
    async getCursor(a) { return db.cursors.has(a) ? db.cursors.get(a) : null; },
    async commitIngest({ agentName, cursor, rows }) {
      let n = 0;
      for (const r of rows) {
        if (r.label?.startsWith('決策') || r.isDecision) {
          if (!db.decisions.some((d) => d.draft_mail_id === r.mailId)) {
            db.decisions.push({
              id: nextDecId++,
              group_id: r.groupId,
              draft_mail_id: r.mailId,
              draft_id: `dec_${r.mailId}`,
              author_agent: r.sender,
              subject: r.subject ?? '',
              summary: r.summary ?? '',
              text: r.text ?? r.summary ?? '',
              status: 'draft',
              version: 1,
              confirmed_by: null,
              confirmed_by_discord_id: null,
              confirmed_by_name: null,
              confirmed_at: null,
              decision_reason: null,
              discord_message_id: null,
              reminder_sent: false,
              reminder_sent_at: null,
              created_at: r.mailCreatedAt ?? new Date().toISOString(),
              updated_at: r.mailCreatedAt ?? new Date().toISOString(),
            });
          }
        }
        if (db.notifs.some((x) => x.member_id === r.memberId && x.mail_id === r.mailId)) continue;
        db.notifs.push({ id: nextId++, group_id: r.groupId, member_id: r.memberId, mail_id: r.mailId, recipient_agent: r.recipientAgent, label: r.label, sender: r.sender, subject: r.subject, summary: r.summary, mail_created_at: r.mailCreatedAt, state: r.state, attempts: 0 });
        n++;
      }
      db.cursors.set(agentName, Math.max(db.cursors.get(agentName) ?? 0, cursor));
      return n;
    },
    async membersWithWork() {
      const ids = [...new Set(db.notifs.filter((x) => ['pending', 'held', 'failed'].includes(x.state)).map((x) => x.member_id))];
      return ids.filter((id) => activeLink(id)).map((id) => ({ memberId: id, discordUserId: activeLink(id).discord_user_id }));
    },
    async getPresence(id) { return db.presence.get(id) ?? null; },
    async setPresenceByDiscord(guildId, userId, status) {
      const l = db.links.find((x) => x.guild_id === guildId && x.discord_user_id === userId && x.status === 'active');
      if (l) db.presence.set(l.member_id, status);
    },
    async holdPending(id) {
      let n = 0;
      for (const x of db.notifs) if (x.member_id === id && x.state === 'pending') { x.state = 'held'; n++; }
      return n;
    },
    async listBacklog(id) { return db.notifs.filter((x) => x.member_id === id && ['held', 'failed'].includes(x.state)).sort((a, b) => a.mail_id - b.mail_id).map((x) => ({ ...x })); },
    async markDigested(ids, msgId) {
      for (const x of db.notifs) if (ids.includes(x.id) && ['held', 'failed'].includes(x.state)) { x.state = 'digested'; x.discord_message_id = msgId; }
    },
    async listPending(id) { return db.notifs.filter((x) => x.member_id === id && x.state === 'pending').sort((a, b) => a.mail_id - b.mail_id).map((x) => ({ ...x })); },
    async markNotification(id, state, { error = null, discordMessageId = null } = {}) {
      const x = db.notifs.find((n) => n.id === id && n.state === 'pending');
      if (x) Object.assign(x, { state, last_error: error, attempts: x.attempts + 1, discord_message_id: discordMessageId ?? x.discord_message_id });
    },
    async recentItems(groupId, limit) {
      const seen = new Set();
      return db.notifs.filter((x) => x.group_id === groupId).sort((a, b) => b.mail_id - a.mail_id)
        .filter((x) => (seen.has(x.mail_id) ? false : seen.add(x.mail_id))).slice(0, limit).map((x) => {
          const dec = db.decisions.find((d) => d.draft_mail_id === x.mail_id);
          let decision_status = undefined;
          if (dec) {
            decision_status = dec.status === 'confirmed' ? '已確認' : dec.status === 'rejected' ? '已駁回' : '草稿';
          } else if (x.label?.startsWith('決策')) {
            decision_status = '草稿';
          }
          return { ...x, ...(decision_status ? { decision_status } : {}) };
        });
    },
    async itemBelongsToGroup(groupId, mailId) { return db.notifs.some((x) => x.group_id === groupId && x.mail_id === mailId); },
    async recordDecisionDraft({ groupId, draftMailId, draftId, authorAgent, subject = '', summary = '', text = '', createdAt = null }) {
      const existing = db.decisions.find((d) => d.draft_mail_id === draftMailId);
      if (existing) return { ...existing };
      const dId = draftId ?? `dec_${draftMailId}`;
      const row = {
        id: nextDecId++, group_id: groupId, draft_mail_id: draftMailId, draft_id: dId,
        author_agent: authorAgent, subject, summary, text, status: 'draft', version: 1,
        confirmed_by: null, confirmed_by_discord_id: null, confirmed_by_name: null, confirmed_at: null,
        decision_reason: null, discord_message_id: null, reminder_sent: false, reminder_sent_at: null,
        created_at: createdAt ?? new Date().toISOString(), updated_at: createdAt ?? new Date().toISOString(),
      };
      db.decisions.push(row);
      return { ...row };
    },
    async getDecisionByMailId(draftMailId) {
      const d = db.decisions.find((x) => x.draft_mail_id === Number(draftMailId));
      return d ? { ...d } : null;
    },
    async getDecisionByDraftId(draftId) {
      const d = db.decisions.find((x) => x.draft_id === String(draftId) || String(x.draft_mail_id) === String(draftId));
      return d ? { ...d } : null;
    },
    async listDecisions(groupId, { status, limit = 50 } = {}) {
      return db.decisions
        .filter((d) => d.group_id === groupId && (!status || d.status === status))
        .sort((a, b) => (a.created_at === b.created_at ? b.id - a.id : b.created_at.localeCompare(a.created_at)))
        .slice(0, limit)
        .map((d) => ({ ...d }));
    },
    async updateDecisionStatus({ draftMailId, status, memberId, discordUserId, memberName, reason = null, now = null }) {
      const d = db.decisions.find((x) => x.draft_mail_id === Number(draftMailId) && x.status === 'draft');
      if (!d) return null;
      const t = now ?? new Date().toISOString();
      d.status = status;
      d.confirmed_by = memberId;
      d.confirmed_by_discord_id = discordUserId;
      d.confirmed_by_name = memberName;
      d.confirmed_at = t;
      d.decision_reason = reason;
      d.version += 1;
      d.updated_at = t;
      return { ...d };
    },
    async listDueDraftReminders(nowMs, timeoutMs = 7 * 24 * 60 * 60 * 1000) {
      const cutoff = nowMs - timeoutMs;
      return db.decisions
        .filter((d) => d.status === 'draft' && !d.reminder_sent && Date.parse(d.created_at) <= cutoff)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map((d) => ({ ...d }));
    },
    async markDraftReminderSent(draftMailId, now = null) {
      const d = db.decisions.find((x) => x.draft_mail_id === Number(draftMailId));
      if (!d) return null;
      const t = now ?? new Date().toISOString();
      d.reminder_sent = true;
      d.reminder_sent_at = t;
      d.updated_at = t;
      return { ...d };
    },
    async reserveBudget({ groupId, day, estimateUsd, capUsd }) {
      const k = `${groupId}|${day}`;
      const b = db.budget.get(k) ?? { spent: 0, reserved: 0, calls: 0, rejected: 0, cap_notified: false };
      db.budget.set(k, b);
      if (b.spent + b.reserved + estimateUsd <= capUsd) { b.reserved += estimateUsd; b.calls++; return true; }
      b.rejected++;
      return false;
    },
    async settleBudget({ groupId, day, reservedUsd, actualUsd }) {
      const b = db.budget.get(`${groupId}|${day}`);
      b.reserved = Math.max(0, b.reserved - reservedUsd);
      b.spent += actualUsd;
    },
    async markCapNotified(groupId, day) {
      const b = db.budget.get(`${groupId}|${day}`);
      if (!b || b.cap_notified) return false;
      b.cap_notified = true;
      return true;
    },
    async budgetRow(groupId, day) { const b = db.budget.get(`${groupId}|${day}`); return b ? { ...b } : null; },
  };
}
