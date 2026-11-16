import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailClient } from '../mail-client.mjs';
import { FakeClock, fakeFetch, toolResult, handshake } from './helpers/fakes.mjs';

const PROJECT = '/data/projects/group-a';
const EVENT_ID = 'a6fac5ad-' + '984e-40cc-9cfb-716cd121b7f9';

function baseItem(over = {}) {
  return {
    to: ['RedStone'],
    subject: '交接登入頁',
    kind: 'handoff',
    intent: 'question',
    sourceSession: 'mac-session-01',
    summary: '登入頁完成',
    text: '測試已通過；下一步待確認',
    links: [],
    unfinished: [],
    clientEventId: EVENT_ID,
    ...over,
  };
}

function client(fetch, over = {}) {
  return createMailClient({
    url: 'http://hub.test/mcp/',
    token: '<HUB_TOKEN>',
    projectKey: PROJECT,
    agentName: 'BlueLake',
    senderToken: '<REGISTRATION_TOKEN>',
    clock: new FakeClock(),
    fetch,
    ...over,
  });
}

test('sendItem saves a handoff and returns the Hub message ID', async () => {
  const fetch = fakeFetch((rpc) => {
    const hs = handshake(rpc);
    if (hs) return hs;
    return toolResult(rpc.id, {
      message_id: 42,
      thread_id: EVENT_ID,
      created_ts: '2026-11-17T01:00:00Z',
      verified_sender: true,
      target_outcomes: [{ recipient: 'RedStone', kind: 'to', outcome: 'delivered' }],
    });
  });
  const res = await client(fetch).sendItem(baseItem());
  assert.equal(res.status, 'saved');
  assert.equal(res.messageId, 42);
  assert.equal(res.createdTs, '2026-11-17T01:00:00Z');
});
