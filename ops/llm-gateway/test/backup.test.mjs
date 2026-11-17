import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, chmodSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('memory backup preserves the request ledger/hash and excludes its writer lock (fake pg_dump)', { skip: spawnSync('sqlite3', ['--version'], { stdio: 'ignore' }).status !== 0 && 'sqlite3 unavailable' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'f11-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scripts = join(dir, 'ops'), llm = join(dir, 'llm'), backups = join(dir, 'backups');
  mkdirSync(scripts); mkdirSync(llm); mkdirSync(backups);
  const backup = join(scripts, 'backup');
  copyFileSync(new URL('../../backup', import.meta.url), backup);
  writeFileSync(join(scripts, 'postgres'), '#!/bin/sh\ncase "$1" in\n dump) printf "FAKE-PG-DUMP" ;;\n verify-dump) cat >/dev/null ;;\n *) exit 1 ;;\nesac\n');
  chmodSync(join(scripts, 'postgres'), 0o700);
  const ledger = JSON.stringify({ v: 1, days: { '2026-11-17': { spentMicros: 9 } }, open: {} });
  writeFileSync(join(llm, 'gemini-requests.json'), ledger, { mode: 0o600 });
  writeFileSync(join(llm, 'gemini-requests.json.lock'), 'DO-NOT-BACK-UP');
  execFileSync('bash', [backup, '--quiet'], { env: { PATH: process.env.PATH, HUB_HINDSIGHT_BACKUP: '1', HUB_LLM_STATE_DIR: llm,
    HUB_DATA_DIR: join(dir, 'absent-data'), HUB_STATE_DIR: join(dir, 'absent-private'), HUB_CLOCK_DIR: join(dir, 'absent-clock'),
    CADDY_SNIPPET: join(dir, 'absent-caddy'), CADDY_PRIVATE_DIR: join(dir, 'absent-caddy-private'), HUB_BANKPROXY_STATE_DIR: join(dir, 'absent-old-ledger'), BACKUP_DIR: backups }, stdio: 'pipe' });
  const archive = join(backups, readdirSync(backups).find((n) => n.endsWith('.tar.gz')));
  const read = (name) => execFileSync('tar', ['-xOzf', archive, './' + name], { encoding: 'utf8' });
  assert.equal(read('llm-gateway/gemini-requests.json'), ledger);
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.hindsight.request_ledger_file, 'llm-gateway/gemini-requests.json');
  assert.equal(manifest.hindsight.request_ledger_sha256, createHash('sha256').update(ledger).digest('hex'));
  assert.equal(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).includes('.lock'), false);
});
