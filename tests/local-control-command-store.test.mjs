import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLocalControlCommandStore
} from '../lib/local-control-command-store.mjs';

test('local control commands are leased, replayed after expiry, and completed idempotently', () => {
  let timestamp = 1000;
  const store = createLocalControlCommandStore({
    now: () => timestamp,
    createId: () => 'command-1',
    leaseMs: 100
  });
  const queued = store.enqueue('pause', { batchId: 'batch-1' });
  assert.equal(queued.state, 'pending');

  assert.deepEqual(store.claimNext(), {
    id: 'command-1',
    command: 'pause',
    payload: { batchId: 'batch-1' },
    createdAt: 1000
  });
  assert.equal(store.claimNext(), null);

  timestamp = 1100;
  assert.equal(store.claimNext().id, 'command-1');
  const completed = store.complete('command-1', { ok: true });
  assert.equal(completed.state, 'completed');
  assert.deepEqual(store.complete('command-1', { ok: false }).result, {
    ok: true
  });
  assert.equal(store.claimNext(), null);
});

test('local control command store rejects unknown commands and malformed payloads', () => {
  const store = createLocalControlCommandStore({
    createId: () => 'command-1'
  });
  assert.throws(
    () => store.enqueue('delete-everything', {}),
    (error) => error?.code === 'local_control_command_forbidden'
  );
  assert.throws(
    () => store.enqueue('status', []),
    (error) => error?.code === 'local_control_payload_invalid'
  );
});
