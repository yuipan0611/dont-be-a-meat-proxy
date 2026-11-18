// TC-16 (AC-12.1～12.5, SR-ID-05, API-05) with a TokenApplier double + the real spool applier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnect } from '../src/connect.mjs';
import { createRouter, EPHEMERAL, NOT_MEMBER } from '../src/router.mjs';
import { createSpoolApplier } from '../src/token-applier.mjs';
import { createMemoryStore } from './helpers/store-memory.mjs';
import { createFakeApplier, seed, fakeInteraction, STRANGER, 維護者 } from './helpers/fakes.mjs';

const HUB = 'https://hub.example.test';
const sha = (s) => createHash('sha256').update(s).digest('hex');

function rig(applierOpts) {
  const store = createMemoryStore(seed());
  const applier = createFakeApplier(applierOpts);
  const connect = createConnect({ store, applier, hubUrl: HUB });
  const router = createRouter({ store, connect, assistant: {} });
  return { store, applier, router };
}
const edit = (ix) => ix.log.find((x) => x.type === 'edit').content;
const tokenIn = (text) => /Token：`(mph_[A-Za-z0-9_-]+)`/.exec(text)?.[1];

test('TC-16: /connect replies ephemerally with install fields; DB keeps only the hash', async () => {
  const r = rig();
  const ix = fakeInteraction('connect', { platform: 'windows', device: 'Windows 桌機' });
  await r.router.handle(ix);
  assert.deepEqual(ix.log[0], { type: 'defer', flags: EPHEMERAL });
  const text = edit(ix);
  const token = tokenIn(text);
  assert.ok(token && token.length > 40);
  assert.match(text, /Agent：`RedStone`/);
  assert.match(text, /平台：`windows`/);
  assert.ok(text.includes("$env:HUB_DIST_URL = 'https://hub.example.test/dist/'"));
  assert.ok(text.includes("Invoke-RestMethod 'https://hub.example.test/install.ps1'"));
  assert.match(text, /組別：`group-a`/);
  assert.doesNotMatch(text, /BlueLake|Authorization|claude mcp add/);
  assert.match(text, /保存與刪除/); // R-8 notice
  const dev = r.store.db.devices.at(-1);
  assert.equal(dev.token_hash, sha(token));
  assert.equal(dev.status, 'active');
  assert.equal(dev.label, '維護者 / Windows 桌機');
  assert.ok(!JSON.stringify(r.store.db.audit).includes(token), 'token never in audit');
  assert.ok(!JSON.stringify(dev).includes(token));
  assert.equal(r.applier.calls[0].token, token, 'raw value only goes to the applier');
});

test('SR-ID-05: every /connect issues a NEW token; older tokens stay valid', async () => {
  const r = rig();
  const a = fakeInteraction('connect', { platform: 'macos' });
  const b = fakeInteraction('connect', { platform: 'macos' });
  await r.router.handle(a);
  await r.router.handle(b);
  assert.notEqual(tokenIn(edit(a)), tokenIn(edit(b)));
  assert.equal(r.store.db.devices.filter((d) => d.status === 'active').length, 4);
});

test('TC-16 / AC-12.3: a non-member is refused and no token is created', async () => {
  const r = rig();
  const ix = fakeInteraction('connect', { platform: 'windows' }, { userId: STRANGER });
  await r.router.handle(ix);
  assert.equal(edit(ix), NOT_MEMBER);
  assert.equal(r.store.db.devices.length, 2);
  assert.equal(r.applier.calls.length, 0);
  assert.equal(r.store.db.audit.at(-1).action, 'discord.connect.denied');
});

test('TC-16 / AC-12.4～12.5: revoke one device → revoked after 401 probe; others unaffected; /connect again gives a new token', async () => {
  const r = rig();
  const c1 = fakeInteraction('connect', { platform: 'windows' });
  await r.router.handle(c1);
  const tokenId = /Token ID：`(tok_[a-z0-9]+)`/.exec(edit(c1))[1];
  const rv = fakeInteraction('revoke', { token_id: tokenId });
  await r.router.handle(rv);
  assert.match(edit(rv), /已撤銷/);
  assert.equal(r.store.db.devices.find((d) => d.token_id === tokenId).status, 'revoked');
  assert.equal(r.store.db.devices.find((d) => d.token_id === 'tok_fakemac01').status, 'active');
  const c2 = fakeInteraction('connect', { platform: 'windows' });
  await r.router.handle(c2);
  assert.notEqual(tokenIn(edit(c2)), tokenIn(edit(c1)));
  // Revoking again / someone else's / unknown id: refused, nothing changes.
  const again = fakeInteraction('revoke', { token_id: tokenId });
  await r.router.handle(again);
  assert.match(edit(again), /找不到/);
});

test('revoke: Caddy not confirmed or probe ≠ 401 → stays revocation_pending and is NOT reported as done', async () => {
  for (const opts of [{ revoke: 'failed' }, { revoke: 'unknown' }, { revoke: 'applied', probe: 200 }]) {
    const r = rig(opts);
    const ix = fakeInteraction('revoke', { token_id: 'tok_fakewin01' });
    await r.router.handle(ix);
    assert.match(edit(ix), /還沒確認完成/);
    assert.equal(r.store.db.devices.find((d) => d.token_id === 'tok_fakewin01').status, 'revocation_pending');
  }
});

test('connect: applier failure → no token shown, row fails closed to revocation_pending', async () => {
  for (const status of ['failed', 'unknown']) {
    const r = rig({ issue: status });
    const ix = fakeInteraction('connect', { platform: 'macos' });
    await r.router.handle(ix);
    assert.equal(tokenIn(edit(ix)), undefined);
    assert.match(edit(ix), /發放失敗/);
    assert.match(edit(ix), /待撤銷/);
    assert.doesNotMatch(edit(ix), /已作廢，不能使用/);
    assert.equal(r.store.db.devices.at(-1).status, 'revocation_pending');
  }
});

test('bad input: bad platform / malformed token id are rejected without side effects', async () => {
  const r = rig();
  const p = fakeInteraction('connect', { platform: 'amiga' });
  await r.router.handle(p);
  assert.match(edit(p), /平台只能是/);
  const t = fakeInteraction('revoke', { token_id: '../../etc' });
  await r.router.handle(t);
  assert.match(edit(t), /格式不對/);
  assert.equal(r.store.db.devices.length, 2);
  assert.equal(維護者.length, 36);
});

test('failed issue persists cancellation before attempting a DB revocation update', async () => {
  const store = createMemoryStore(seed()), events = [];
  store.requestRevocation = async () => { events.push('db'); throw new Error('synthetic DB outage'); };
  const connect = createConnect({ store, hubUrl: HUB, applier: {
    issue: async () => ({ status: 'unknown' }),
    cancelIssue: async r => { events.push('cancel'); assert.match(r.tokenId, /^tok_/); },
  } });
  await assert.rejects(connect.connect({ member: { memberId: 維護者, groupId: 'group-a' }, platform: 'macos',
    requestId: 'cancel-before-db', actorId: 'synthetic' }), /synthetic DB outage/);
  assert.deepEqual(events, ['cancel', 'db']);
});

test('spool cancellation queues without waiting for a receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'l03-cancel-'));
  try {
    const applier = createSpoolApplier({ dir });
    assert.equal(typeof applier.cancelIssue, 'function');
    await applier.cancelIssue({ requestId: 'late123', groupId: 'group-a', tokenId: 'tok_' + '0123abcd' });
    const req = JSON.parse(await readFile(join(dir, 'requests/late123-cancel.json'), 'utf8'));
    assert.equal(req.op, 'cancel_issue');
    assert.equal(req.token_id, 'tok_' + '0123abcd');
    assert.equal((await stat(join(dir, 'requests/late123-cancel.json'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('spool applier: writes 0600 request + credential atomically and reads the helper receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'l03-spool-'));
  try {
    const applier = createSpoolApplier({ dir, timeoutMs: 2000, pollMs: 10 });
    const helper = (async () => {
      for (;;) {
        const reqs = await readdir(join(dir, 'requests')).catch(() => []);
        const f = reqs.find((x) => x.endsWith('.json'));
        if (f) {
          const req = JSON.parse(await readFile(join(dir, 'requests', f), 'utf8'));
          await writeFile(join(dir, 'receipts', f), JSON.stringify({ request_id: req.request_id, status: 'applied', config_revision: 3 }));
          return req;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    })();
    const res = await applier.issue({ requestId: 'ix123', groupId: 'group-a', tokenId: 'tok_' + '0123abcd', token: 'mph_secret' });
    const req = await helper;
    assert.deepEqual(res, { status: 'applied', configRevision: 3, probe: null, error: null });
    assert.equal(req.op, 'issue');
    assert.ok(Number.isSafeInteger(req.expires_at) && req.expires_at > Date.now() - 2000);
    assert.equal(req.credential_ref, 'credentials/tok_' + '0123abcd');
    assert.ok(!JSON.stringify(req).includes('mph_secret'), 'request JSON has a ref, not the token');
    assert.equal((await readFile(join(dir, 'credentials', 'tok_' + '0123abcd'), 'utf8')).trim(), 'mph_secret');
    assert.equal((await stat(join(dir, 'credentials', 'tok_' + '0123abcd'))).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'requests'))).mode & 0o777, 0o700);
    const timeout = await createSpoolApplier({ dir, timeoutMs: 30, pollMs: 10 }).revoke({ requestId: 'ix124', groupId: 'group-a', tokenId: 'tok_' + '0123abcd' });
    assert.equal(timeout.status, 'unknown');
    await assert.rejects(applier.revoke({ requestId: '../x', groupId: 'group-a', tokenId: 'tok_' + '0123abcd' }), /bad request id/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
