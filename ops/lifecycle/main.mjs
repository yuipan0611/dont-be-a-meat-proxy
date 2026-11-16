#!/usr/bin/env node
// main.mjs — HubClock service entry point (H-05).
//
//   node ops/lifecycle/main.mjs run    [--private-dir D] [--data-dir D] [--url U] [--group G] [--interval-s 15]
//   node ops/lifecycle/main.mjs once   (one tick, then exit; for operators / smoke tests)
//   node ops/lifecycle/main.mjs status (summary of state; prints no credentials)
//
// Credentials come only from H-02's private directory (mode 600 files), never from argv or output:
//   <private-dir>/mail-a.env            HTTP_BEARER_TOKEN=…   (upstream token; HubClock talks to
//                                                              mail-a on 127.0.0.1, not via Caddy)
//   <private-dir>/hubclock.sender.json  { agentName, senderToken, projectKey }
//                                       agentName is the name Mail generated at register time;
//                                       HubClock is a role, the name is never hard-coded.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createMailClient, MailError } from '../../client/mail-client.mjs';
import { createFileStore, LockLostError } from './store-file.mjs';
import { createLifecycle } from './lifecycle.mjs';

const systemClock = { nowMs: () => Date.now() };

async function privateText(path) {
  const st = await stat(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must not be readable by group/others (chmod 600)`);
  return readFile(path, 'utf8');
}

export async function loadIdentity(privateDir) {
  const env = await privateText(join(privateDir, 'mail-a.env'));
  const token = env.match(/^HTTP_BEARER_TOKEN=([A-Za-z0-9_-]{32,128})$/m)?.[1];
  if (!token) throw new Error('mail-a.env has no valid HTTP_BEARER_TOKEN');
  const sender = JSON.parse(await privateText(join(privateDir, 'hubclock.sender.json')));
  for (const k of ['agentName', 'senderToken', 'projectKey']) {
    if (typeof sender[k] !== 'string' || !sender[k]) throw new Error(`hubclock.sender.json missing ${k}`);
  }
  return { token, ...sender };
}

const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'hubclock', ...obj }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'private-dir': { type: 'string', default: process.env.HUB_PRIVATE_DIR ?? '/var/lib/neighbor-hub/private' },
      'data-dir': { type: 'string', default: process.env.HUBCLOCK_DATA_DIR ?? '/var/lib/neighbor-hub/hubclock' },
      url: { type: 'string', default: process.env.HUBCLOCK_MAIL_URL ?? 'http://127.0.0.1:8765/mcp/' },
      group: { type: 'string', default: process.env.HUB_GROUP_ID ?? 'group-a' },
      'interval-s': { type: 'string', default: process.env.HUBCLOCK_INTERVAL_S ?? '15' },
      'lease-s': { type: 'string', default: '60' },
    },
  });
  const cmd = positionals[0] ?? 'run';
  const store = createFileStore({ dir: values['data-dir'], clock: systemClock, leaseMs: Number(values['lease-s']) * 1000 });

  if (cmd === 'status') {
    const s = await store.snapshot();
    const by = {};
    for (const r of Object.values(s.requests)) by[`${r.kind}:${r.status}`] = (by[`${r.kind}:${r.status}`] ?? 0) + 1;
    const pending = Object.values(s.outbox).filter((e) => e.state !== 'sent').map((e) => ({ eventKey: e.eventKey, state: e.state, attempts: e.attempts, lastError: e.lastError }));
    console.log(JSON.stringify({ cursor: s.cursor, requests: by, outboxNotSent: pending }, null, 2));
    return 0;
  }

  const id = await loadIdentity(values['private-dir']);
  const client = createMailClient({ url: values.url, token: id.token, projectKey: id.projectKey, agentName: id.agentName, senderToken: id.senderToken });
  const lc = createLifecycle({ client, store, clock: systemClock, groupId: values.group, log });
  const intervalMs = Number(values['interval-s']) * 1000;

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    for (;;) {
      const lock = await store.acquireLock();
      if (!lock.acquired) {
        log({ ev: 'standby', reason: 'another HubClock writer holds the lock', holder: lock.holder });
        if (cmd === 'once') return 3;
      } else {
        try {
          const r = await lc.tick();
          log({ ev: 'tick', ...r });
        } catch (e) {
          if (e instanceof LockLostError) { log({ ev: 'lock_lost', holder: e.holder }); return 4; }
          if (e instanceof MailError && e.code === 'E-AUTH') { log({ ev: 'fatal', code: e.code, msg: 'Mail rejected HubClock credentials' }); return 2; }
          log({ ev: 'tick_failed', code: e.code ?? e.name, reason: e.reason, msg: e.message });
          if (cmd === 'once') return 1;
        }
      }
      if (cmd === 'once' || stopping) return 0;
      for (let waited = 0; waited < intervalMs && !stopping; waited += 250) await sleep(250);
      if (stopping) return 0;
    }
  } finally {
    await store.releaseLock();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (e) => { log({ ev: 'crash', msg: e.message }); process.exit(1); });
}
