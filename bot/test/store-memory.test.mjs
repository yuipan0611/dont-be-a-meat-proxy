// The in-memory twin must pass the same contract the real Postgres store passes.
import { test } from 'node:test';
import { storeContract } from './helpers/store-contract.mjs';
import { createMemoryStore } from './helpers/store-memory.mjs';
import { seed } from './helpers/fakes.mjs';
import { classifySendError } from '../src/discord.mjs';
import assert from 'node:assert/strict';

storeContract(test, async () => createMemoryStore(seed()));

test('discord send errors: 4xx/429 = failed (not delivered); 5xx/timeout/network = unknown', () => {
  assert.equal(classifySendError({ status: 403, code: 50007 }).outcome, 'failed');
  assert.equal(classifySendError({ status: 429 }).outcome, 'failed');
  assert.equal(classifySendError({ status: 502 }).outcome, 'unknown');
  assert.equal(classifySendError(Object.assign(new Error('x'), { name: 'AbortError' })).outcome, 'unknown');
  assert.equal(classifySendError(new Error('ECONNRESET')).outcome, 'unknown');
});
