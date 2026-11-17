// Config helpers: secrets come from files; mail-a.env (H-02 format) or a bare token both work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mailToken } from '../src/main.mjs';
import { COMMANDS } from '../src/router.mjs';

test('mailToken reads HTTP_BEARER_TOKEN from mail-a.env or a bare token, rejects junk', () => {
  const tok = 'A'.repeat(40);
  assert.equal(mailToken(`RUST_LOG=warn\nHTTP_BEARER_TOKEN=${tok}\n`), tok);
  assert.equal(mailToken(`${tok}\n`), tok);
  assert.throws(() => mailToken('HTTP_BEARER_TOKEN=short\n'), /no valid upstream token/);
});

test('slash commands: exactly connect / revoke / status; no write-capable assistant command', () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), ['connect', 'revoke', 'status']);
  const status = COMMANDS.find((c) => c.name === 'status');
  assert.equal(status.options.find((o) => o.name === 'public').required, false);
});
