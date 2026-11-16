// store-file.mjs — MVP store for HubClock: one JSON state file + one lease lock file.
//
// Store interface (the 11-30 Postgres store implements the same shape, mapped to the T15 tables
// hub_clock_requests / hub_clock_outbox / hub_clock_cursors — see ops/lifecycle/README.md):
//
//   acquireLock() → { acquired, holder }     renewLock()  (throws LockLostError)
//   releaseLock()                             transact(async (tx) => …)   all-or-nothing
//
//   tx.getCursor() / tx.setCursor(c)
//   tx.isProcessed(messageId) / tx.markProcessed(messageId)
//   tx.getRequest(key) / tx.putRequest(req) / tx.listRequests(pred)
//   tx.getOutbox(eventKey) / tx.putOutbox(entry) / tx.listOutbox(pred)
//
// transact() checks the lock is still ours before writing (fencing), so a stalled old writer that
// lost its lease cannot overwrite the new writer's state.

import { mkdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

export class LockLostError extends Error {
  constructor(message, holder) {
    super(message);
    this.name = 'LockLostError';
    this.holder = holder;
  }
}

const STATE_SCHEMA = 1;
const PROCESSED_KEEP = 20_000; // message IDs remembered for duplicate-event suppression

function emptyState() {
  return { schema: STATE_SCHEMA, cursor: null, requests: {}, outbox: {}, processed: [] };
}

async function atomicWrite(path, data) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * @param {object} o
 * @param {string} o.dir         state directory (0700, excluded from Git; on the VPS under H-02's state dir)
 * @param {{nowMs:()=>number}} o.clock
 * @param {number} [o.leaseMs]   lock is stale when its heartbeat is older than this (default 60 s)
 * @param {string} [o.owner]     unique writer ID
 */
export function createFileStore({ dir, clock, leaseMs = 60_000, owner = `${hostname()}:${process.pid}:${randomUUID()}` }) {
  const statePath = join(dir, 'hubclock-state.json');
  const lockPath = join(dir, 'hubclock.lock');

  async function ensureDir() {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  async function readLock() {
    return readJson(lockPath);
  }

  async function writeNewLock() {
    const now = clock.nowMs();
    const body = JSON.stringify({ owner, pid: process.pid, host: hostname(), acquiredAt: now, heartbeatAt: now });
    const fh = await open(lockPath, 'wx', 0o600); // O_EXCL: only one creator wins
    try {
      await fh.writeFile(body, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  async function acquireLock() {
    await ensureDir();
    for (let i = 0; i < 2; i++) {
      try {
        await writeNewLock();
        return { acquired: true, holder: owner };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const cur = await readLock();
      if (!cur) continue; // vanished between create and read; try again
      if (cur.owner === owner) {
        await renewLock();
        return { acquired: true, holder: owner };
      }
      if (clock.nowMs() - cur.heartbeatAt <= leaseMs) return { acquired: false, holder: cur.owner };
      // Stale: move it aside atomically. If two writers race, only one rename succeeds.
      try {
        await rename(lockPath, `${lockPath}.stale-${randomUUID()}`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    const cur = await readLock();
    return { acquired: false, holder: cur?.owner ?? null };
  }

  async function assertHeld() {
    const cur = await readLock();
    if (!cur || cur.owner !== owner) throw new LockLostError('HubClock writer lock lost', cur?.owner ?? null);
    return cur;
  }

  async function renewLock() {
    const cur = await assertHeld();
    await atomicWrite(lockPath, JSON.stringify({ ...cur, heartbeatAt: clock.nowMs() }));
  }

  async function releaseLock() {
    const cur = await readLock();
    if (cur?.owner === owner) await unlink(lockPath).catch(() => {});
  }

  async function load() {
    const s = await readJson(statePath);
    if (!s) return emptyState();
    if (s.schema !== STATE_SCHEMA) throw new Error(`unsupported HubClock state schema ${s.schema}`);
    return s;
  }

  async function transact(fn) {
    await ensureDir();
    await assertHeld();
    const state = await load();
    const processed = new Set(state.processed);
    const tx = {
      getCursor: () => state.cursor,
      setCursor: (c) => void (state.cursor = c),
      isProcessed: (id) => processed.has(id),
      markProcessed: (id) => void processed.add(id),
      getRequest: (key) => (state.requests[key] ? structuredClone(state.requests[key]) : null),
      putRequest: (req) => void (state.requests[req.key] = structuredClone(req)),
      listRequests: (pred = () => true) => Object.values(state.requests).filter(pred).map((r) => structuredClone(r)),
      getOutbox: (k) => (state.outbox[k] ? structuredClone(state.outbox[k]) : null),
      putOutbox: (e) => void (state.outbox[e.eventKey] = structuredClone(e)),
      listOutbox: (pred = () => true) => Object.values(state.outbox).filter(pred).map((e) => structuredClone(e)),
    };
    const result = await fn(tx);
    state.processed = [...processed].slice(-PROCESSED_KEEP);
    await assertHeld(); // fencing: never write after losing the lease
    await atomicWrite(statePath, JSON.stringify(state, null, 1));
    return result;
  }

  /** Read-only snapshot for tests / status output. */
  async function snapshot() {
    return load();
  }

  return { acquireLock, renewLock, releaseLock, transact, snapshot, owner, statePath, lockPath };
}
