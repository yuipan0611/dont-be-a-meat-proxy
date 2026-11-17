// Test doubles: Mail (per-agent inbox events), Discord (DM sink), Clock, LLM, TokenApplier, interaction.

export const GUILD = '10000000\x30000000001';
export const OWNER_DISCORD = '20000000\x30000000001';
export const STRANGER = '20000000\x30000000099';
export const 維護者 = '00000000-0000-4000-8000-0000000000a1';

export function seed() {
  return {
    groups: [{ id: 'group-a' }],
    members: [{ id: 維護者, group_id: 'group-a', display_name: '維護者', role: 'owner' }],
    links: [{ member_id: 維護者, guild_id: GUILD, discord_user_id: OWNER_DISCORD }],
    devices: [
      { member_id: 維護者, group_id: 'group-a', token_id: 'tok_fakemac01', token_hash: 'a'.repeat(64), allowed_agents: ['BlueLake'] },
      { member_id: 維護者, group_id: 'group-a', token_id: 'tok_fakewin01', token_hash: 'b'.repeat(64), allowed_agents: ['RedStone'] },
    ],
  };
}

export class FakeClock {
  constructor(iso = '2026-11-20T02:00:00.000Z') { this.ms = Date.parse(iso); }
  nowMs() { return this.ms; }
  advance(ms) { this.ms += ms; }
  iso(offsetMs = 0) { return new Date(this.ms + offsetMs).toISOString().replace('Z', '000Z'); }
}

export function itemBody({ kind = 'handoff', intent = 'question', summary = '摘要', text = '全文', clientEventId = 'e1' } = {}) {
  return JSON.stringify({ v: 1, client_event_id: clientEventId, kind, intent, summary, text, links: [], unfinished: [] });
}

export function createFakeMail() {
  const messages = new Map();
  const inbox = new Map(); // agent -> [{cursor, message_id}]
  let seq = 0;
  let nextMsg = 1;
  let down = false;
  return {
    messages, inbox,
    setDown(v) { down = v; },
    /** Simulates a message the Hub has saved and delivered to `to` (and cc). */
    deliver({ from = 'BlueLake', to = ['RedStone'], cc = [], subject = '交接', topic = 'handoff', body = itemBody(), createdTs, threadId }) {
      const id = nextMsg++;
      messages.set(id, { id, from, to, cc, subject, topic, body_md: body, created_ts: createdTs, thread_id: threadId ?? JSON.parse(body).client_event_id });
      for (const a of [...to, ...cc]) {
        if (!inbox.has(a)) inbox.set(a, []);
        inbox.get(a).push({ cursor: ++seq, message_id: id });
      }
      return id;
    },
    async fetchEvents({ agentName, after, limit }) {
      if (down) throw Object.assign(new Error('hub down'), { code: 'E-HUB' });
      const all = inbox.get(agentName) ?? [];
      const evs = all.filter((e) => after === undefined || e.cursor > after).slice(0, limit);
      return { events: evs, nextCursor: evs.at(-1)?.cursor ?? after ?? 0, hasMore: all.filter((e) => e.cursor > (evs.at(-1)?.cursor ?? Infinity)).length > 0, tailCursor: seq };
    },
    async readMessage(id) {
      const m = messages.get(id);
      if (!m) throw new Error('not found');
      return { raw: JSON.stringify(m), message: { ...m } };
    },
  };
}

export function createFakeDiscord() {
  const sent = [];
  let failNext = 0;
  let mode = 'failed';
  return {
    sent,
    failNextSends(n, outcome = 'failed') { failNext = n; mode = outcome; },
    async sendDm(userId, content) {
      if (failNext > 0) {
        failNext--;
        throw Object.assign(new Error('discord unavailable'), { outcome: mode, code: 'DISCORD_DOWN' });
      }
      sent.push({ userId, content });
      return { messageId: `dm-${sent.length}` };
    },
  };
}

/** Scripted Messages API: each entry is a response or a function(params) → response. */
export function createFakeLlm(script) {
  const calls = [];
  return {
    calls,
    async create(params) {
      calls.push(structuredClone(params));
      const next = script.shift();
      if (!next) throw new Error('llm script exhausted');
      return typeof next === 'function' ? next(params) : next;
    },
  };
}

export const llmText = (text, usage = { input_tokens: 800, output_tokens: 120 }) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });
export const llmTool = (name, input, id = 'tu_1', usage = { input_tokens: 700, output_tokens: 40 }) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }], usage });

export function createFakeApplier({ issue = 'applied', revoke = 'applied', probe = 401 } = {}) {
  const calls = [];
  return {
    calls,
    async issue(r) { calls.push({ op: 'issue', ...r }); return { status: issue, configRevision: 7 }; },
    async revoke(r) { calls.push({ op: 'revoke', ...r }); return { status: revoke, probe, configRevision: 8 }; },
  };
}

let ixSeq = 1000;
export function fakeInteraction(commandName, opts = {}, { userId = OWNER_DISCORD, guildId = GUILD } = {}) {
  const log = [];
  return {
    log,
    id: String(ixSeq++),
    commandName,
    guildId,
    user: { id: userId },
    options: {
      getString: (k) => opts[k] ?? null,
      getBoolean: (k) => opts[k] ?? null,
    },
    async deferReply(o) { log.push({ type: 'defer', ...o }); },
    async editReply(o) { log.push({ type: 'edit', ...o }); },
    async followUp(o) { log.push({ type: 'followUp', ...o }); },
  };
}
