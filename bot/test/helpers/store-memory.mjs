// In-memory twin of src/store-pg.mjs for unit tests. test/store-pg.integration.test.mjs runs the
// same contract (test/helpers/store-contract.mjs) against both, so the twin cannot drift silently.

export function createMemoryStore({ groups = [], members = [], links = [], devices = [] } = {}) {
  const db = {
    groups: [...groups],
    members: members.map((m) => ({ role: 'member', status: 'active', ...m })),
    links: links.map((l) => ({ status: 'active', ...l })),
    devices: devices.map((d) => ({ status: 'active', allowed_agents: [], ...d })),
    audit: [], cursors: new Map(), notifs: [], presence: new Map(), budget: new Map(),
  };
  let nextId = 1;
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
        .filter((x) => (seen.has(x.mail_id) ? false : seen.add(x.mail_id))).slice(0, limit).map((x) => ({ ...x }));
    },
    async itemBelongsToGroup(groupId, mailId) { return db.notifs.some((x) => x.group_id === groupId && x.mail_id === mailId); },
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
