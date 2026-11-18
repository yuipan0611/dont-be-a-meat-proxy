#!/usr/bin/env node
// main.mjs — L-02b memory bridge service entry (same shape as ops/lifecycle/main.mjs).
//
//   node ops/memory-bridge/main.mjs run      one writer, ticks every --interval-s
//   node ops/memory-bridge/main.mjs once     one tick, then exit (operators / smoke tests)
//   node ops/memory-bridge/main.mjs status   counts by status + records not indexed (no credentials)
//   node ops/memory-bridge/main.mjs reindex <mailId> [--force]   re-queue / backfill one Mail message
//
// Credentials (files, mode 600, never argv/output):
//   <private-dir>/mail-a.env                  HTTP_BEARER_TOKEN=… (Mail upstream, inside mail_a_net)
//   <private-dir>/memorybridge.sender.json    { agentName, senderToken, projectKey } from ops/bootstrap
//   <private-dir>/hindsight-api.key           Hindsight tenant key (inside memory-net)

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createMailClient, MailError } from '../../client/mail-client.mjs';
import { createFileStore, LockLostError } from '../lifecycle/store-file.mjs';
import { createBridge } from './bridge.mjs';
import { createHindsightClient } from './hindsight-client.mjs';
import { errorDiagnostic, redactLegacyError } from './diagnostics.mjs';

const systemClock = { nowMs: () => Date.now() };
const log = (obj) => console.log(JSON.stringify({ t: new Date().toISOString(), svc: 'memory-bridge', ...obj }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function privateText(path) {
  const st = await stat(path);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path} must not be readable by group/others (chmod 600)`);
  return readFile(path, 'utf8');
}

export async function loadIdentity(privateDir) {
  const env = await privateText(join(privateDir, 'mail-a.env'));
  const token = env.match(/^HTTP_BEARER_TOKEN=([A-Za-z0-9_-]{32,128})$/m)?.[1];
  if (!token) throw new Error('mail-a.env has no valid HTTP_BEARER_TOKEN');
  const sender = JSON.parse(await privateText(join(privateDir, 'memorybridge.sender.json')));
  for (const k of ['agentName', 'senderToken', 'projectKey']) {
    if (typeof sender[k] !== 'string' || !sender[k]) throw new Error(`memorybridge.sender.json missing ${k}`);
  }
  const hindsightKey = (await privateText(join(privateDir, 'hindsight-api.key'))).trim();
  if (!hindsightKey) throw new Error('hindsight-api.key is empty');
  return { token, hindsightKey, ...sender };
}

async function scrubLegacyErrors(store) {
  const { requests } = await store.snapshot();
  const hasLegacyError = (r) => r.lastError && Object.hasOwn(r.lastError, 'message');
  if (!Object.values(requests).some(hasLegacyError)) return;
  await store.transact((tx) => {
    for (const r of tx.listRequests(hasLegacyError)) {
      tx.putRequest({ ...r, lastError: redactLegacyError(r.lastError) });
    }
  });
}

export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'private-dir': { type: 'string', default: process.env.HUB_PRIVATE_DIR ?? '/var/lib/neighbor-hub/private' },
      'data-dir': { type: 'string', default: process.env.BRIDGE_DATA_DIR ?? '/var/lib/neighbor-hub/memory-bridge' },
      url: { type: 'string', default: process.env.BRIDGE_MAIL_URL ?? 'http://127.0.0.1:8765/mcp/' },
      hindsight: { type: 'string', default: process.env.BRIDGE_HINDSIGHT_URL ?? 'http://hindsight:8888' },
      bank: { type: 'string', default: process.env.BRIDGE_BANK ?? 'group-a' },
      'interval-s': { type: 'string', default: process.env.BRIDGE_INTERVAL_S ?? '15' },
      'lease-s': { type: 'string', default: '60' },
      force: { type: 'boolean', default: false },
    },
  });
  const cmd = positionals[0] ?? 'run';
  const store = createFileStore({ dir: values['data-dir'], clock: systemClock, leaseMs: Number(values['lease-s']) * 1000 });

  if (cmd === 'status') {
    const s = await store.snapshot();
    const by = {};
    for (const r of Object.values(s.requests)) by[r.status] = (by[r.status] ?? 0) + 1;
    const notIndexed = Object.values(s.requests).filter((r) => r.status !== 'indexed')
      .map((r) => ({ mailId: r.mailId, kind: r.kind, status: r.status, attempts: r.attempts,
        lastAttemptAt: r.lastAttemptAt && new Date(r.lastAttemptAt).toISOString(), nextTryAt: r.nextTryAt && new Date(r.nextTryAt).toISOString(), lastError: redactLegacyError(r.lastError) }));
    const lastIndexed = Math.max(0, ...Object.values(s.requests).map((r) => r.indexedAt ?? 0));
    console.log(JSON.stringify({ cursor: s.cursor, byStatus: by, lastIndexedAt: lastIndexed ? new Date(lastIndexed).toISOString() : null, notIndexed }, null, 2));
    return 0;
  }
  if (!['run', 'once', 'reindex'].includes(cmd)) {
    console.error('usage: main.mjs run | once | status | reindex <mailId> [--force]');
    return 2;
  }

  const id = await loadIdentity(values['private-dir']);
  const mail = createMailClient({ url: values.url, token: id.token, projectKey: id.projectKey, agentName: id.agentName, senderToken: id.senderToken });
  const hindsight = createHindsightClient({ url: values.hindsight, apiKey: id.hindsightKey });
  const bridge = createBridge({ mail, hindsight, store, clock: systemClock, bank: values.bank, log });

  const lock = await store.acquireLock();
  if (!lock.acquired) {
    log({ ev: 'standby', reason: 'another bridge writer holds the lock', holder: lock.holder });
    if (cmd !== 'run') return 3;
  }

  if (cmd === 'reindex') {
    try {
      await scrubLegacyErrors(store);
      const mailId = Number(positionals[1]);
      if (!Number.isInteger(mailId) || mailId <= 0) { console.error('usage: main.mjs reindex <mailId> [--force]'); return 2; }
      const r = await bridge.reindex(mailId, { force: values.force });
      log({ ev: 'reindex_queued', mail_id: mailId, status: r.status });
      return 0;
    } finally {
      await store.releaseLock();
    }
  }

  const intervalMs = Number(values['interval-s']) * 1000;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let scrubbed = false;
  try {
    for (;;) {
      const held = (await store.acquireLock()).acquired;
      if (held) {
        try {
          if (!scrubbed) {
            await scrubLegacyErrors(store);
            scrubbed = true;
          }
          const r = await bridge.tick();
          log({ ev: 'tick', ...r });
        } catch (e) {
          if (e instanceof LockLostError) { log({ ev: 'lock_lost', holder: e.holder }); return 4; }
          if (e instanceof MailError && e.code === 'E-AUTH') { log({ ev: 'fatal', code: e.code, msg: 'Mail rejected bridge credentials' }); return 2; }
          log({ ev: 'tick_failed', ...errorDiagnostic('BRIDGE_TICK_FAILED', e) });
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
  main().then((code) => process.exit(code), (e) => { log({ ev: 'crash', ...errorDiagnostic('BRIDGE_CRASH', e) }); process.exit(1); });
}
