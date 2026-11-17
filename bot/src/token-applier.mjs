// token-applier.mjs — bot side of the TokenApplier seam (SDS API-05 / GAP-14, docs/08 §5).
//
// The bot has no Docker socket and no Caddy admin. It only writes a request into a private spool
// and waits for the host helper's receipt:
//
//   <spool>/credentials/<token_id>      0600  raw token (issue only; helper moves it to secrets/tokens/)
//   <spool>/requests/<request_id>.json  0600  { v:1, op:"issue"|"revoke", request_id, group_id, token_id,
//                                               credential_ref?, created_at }
//   <spool>/receipts/<request_id>.json         { request_id, status:"applied"|"failed", config_revision?,
//                                               probe?: 401|<http status>, error? }   (written by helper)
//
// Files are written tmp+rename so the helper never sees half a request. No receipt within
// `timeoutMs` → status 'unknown' (callers fail closed). The host helper itself is NOT part of
// L-03 (see docs/ops/runbook-L03-discord.md §未完成).

import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createSpoolApplier({ dir, timeoutMs = 30_000, pollMs = 250, now = () => new Date().toISOString() }) {
  const sub = (n) => join(dir, n);

  async function atomic(path, data) {
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, path);
  }

  async function submit(req, credential) {
    for (const n of ['credentials', 'requests', 'receipts']) await mkdir(sub(n), { recursive: true, mode: 0o700 });
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(req.request_id) || !/^tok_[a-z0-9]{8,32}$/.test(req.token_id)) throw new Error('bad request id / token id');
    if (credential !== undefined) {
      await atomic(join(sub('credentials'), req.token_id), `${credential}\n`);
      req.credential_ref = `credentials/${req.token_id}`;
    }
    await atomic(join(sub('requests'), `${req.request_id}.json`), JSON.stringify({ v: 1, ...req, created_at: now() }));
    const receiptPath = join(sub('receipts'), `${req.request_id}.json`);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const r = JSON.parse(await readFile(receiptPath, 'utf8'));
        if (r.request_id === req.request_id) {
          return { status: r.status === 'applied' ? 'applied' : 'failed', configRevision: r.config_revision ?? null, probe: r.probe ?? null, error: r.error ?? null };
        }
      } catch {}
      if (Date.now() >= deadline) return { status: 'unknown', error: 'no receipt before timeout' };
      await sleep(pollMs);
    }
  }

  return {
    issue: ({ requestId, groupId, tokenId, token }) => submit({ op: 'issue', request_id: requestId, group_id: groupId, token_id: tokenId }, token),
    revoke: ({ requestId, groupId, tokenId }) => submit({ op: 'revoke', request_id: requestId, group_id: groupId, token_id: tokenId }),
  };
}
