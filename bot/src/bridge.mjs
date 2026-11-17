// bridge.mjs — reads saved Mail for each watched agent and queues Discord notifications (US-09).
//
// Source of truth is Mail itself: a notification row is created only for a message the Hub has
// already stored (SR-NTF-01 / AC-09.4 — a failed send never reaches any inbox, so it is never
// notified). The bridge peeks with fetch_inbox_events + resources/read, which do NOT mark
// anything read; the agent still gets the item at its next session start.
//
// One transaction per agent page: rows + cursor advance together, so a crash re-reads the page
// and the (member_id, mail_id) unique key drops duplicates.
//
// §4.5 #9: items older than `freshMs` when ingested (bot was down, Discord was down) go straight
// to `held` and are summarised in one digest instead of being replayed one by one.

import { classifyMessage } from './notify-format.mjs';

export function createBridge({ mail, store, clock, freshMs = 10 * 60_000, pageLimit = 100, log = () => {} }) {
  async function ingestAgent(w) {
    let cursor = await store.getCursor(w.agentName);
    if (cursor === null) {
      // First time we watch this agent: start at the tail. History is not a notification.
      const head = await mail.fetchEvents({ agentName: w.agentName, limit: 1 });
      await store.commitIngest({ agentName: w.agentName, groupId: w.groupId, cursor: Number(head.tailCursor ?? 0), rows: [] });
      log({ ev: 'bridge.start', agent: w.agentName, cursor: head.tailCursor ?? 0 });
      return 0;
    }
    let queued = 0;
    for (;;) {
      const page = await mail.fetchEvents({ agentName: w.agentName, after: cursor, limit: pageLimit });
      if (!page.events.length) return queued;
      const rows = [];
      for (const ev of page.events) {
        const { message } = await mail.readMessage(ev.message_id);
        const n = classifyMessage(message);
        if (!n) continue;
        const age = clock.nowMs() - Date.parse(n.createdTs);
        for (const memberId of w.memberIds) {
          rows.push({
            groupId: w.groupId, memberId, mailId: n.mailId, recipientAgent: w.agentName, label: n.label,
            sender: n.sender, subject: n.subject, summary: n.summary, mailCreatedAt: n.createdTs,
            state: age > freshMs ? 'held' : 'pending',
          });
        }
      }
      const next = Number(page.nextCursor ?? page.events.at(-1).cursor);
      const inserted = await store.commitIngest({ agentName: w.agentName, groupId: w.groupId, cursor: next, rows });
      queued += inserted;
      cursor = next;
      if (!page.hasMore) return queued;
    }
  }

  async function tick() {
    const watched = await store.watchedAgents();
    let queued = 0;
    for (const w of watched) {
      try {
        queued += await ingestAgent(w);
      } catch (e) {
        // One agent failing (Hub down) must not stop the others; the cursor did not move.
        log({ ev: 'bridge.error', agent: w.agentName, error: e.code ?? e.message });
      }
    }
    return { watched: watched.length, queued };
  }

  return { tick, ingestAgent };
}

/** Adapter over client/mail-client.mjs: peek any agent's inbox with the group's backend credential. */
export function createMailReader({ client, projectKey }) {
  return {
    async fetchEvents({ agentName, after, limit }) {
      const args = { project_key: projectKey, agent_name: agentName, limit };
      if (after !== undefined && after !== null) args.after = after;
      const r = await client.callTool('fetch_inbox_events', args);
      return { events: r.events ?? [], nextCursor: r.next_cursor, hasMore: r.has_more === true, tailCursor: r.tail_cursor };
    },
    readMessage: (id) => client.readMessage(id),
  };
}
