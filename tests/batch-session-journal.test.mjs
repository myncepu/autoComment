import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BATCH_SESSION_JOURNAL_PREFIX,
  createBatchSessionJournal
} from '../lib/batch-session-journal.mjs';

function createSessionArea() {
  const data = {};
  const setCalls = [];
  const removeCalls = [];
  return {
    data,
    setCalls,
    removeCalls,
    area: {
      async get(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.flatMap((key) => (
          Object.hasOwn(data, key)
            ? [[key, structuredClone(data[key])]]
            : []
        )));
      },
      async set(values) {
        setCalls.push(structuredClone(values));
        Object.assign(data, structuredClone(values));
      },
      async remove(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        removeCalls.push(structuredClone(requested));
        requested.forEach((key) => delete data[key]);
      }
    }
  };
}

function record(patch = {}) {
  return {
    requestId: 'batch-1:3:2',
    batchId: 'batch-1',
    urlIndex: 3,
    attempt: 2,
    tabId: null,
    windowId: 42,
    ownerPageTabId: 9,
    ownershipEpoch: 'epoch-123',
    createdAt: 1700,
    ...patch
  };
}

test('journals pre-create and bound ownership under one canonical request key', async () => {
  const session = createSessionArea();
  const journal = createBatchSessionJournal(session.area);

  await journal.write(record());
  assert.deepEqual(await journal.read('batch-1:3:2'), record());

  await journal.write(record({ tabId: 501 }));
  assert.deepEqual(
    session.setCalls,
    [
      {
        [`${BATCH_SESSION_JOURNAL_PREFIX}batch-1:3:2`]: record()
      },
      {
        [`${BATCH_SESSION_JOURNAL_PREFIX}batch-1:3:2`]:
          record({ tabId: 501 })
      }
    ]
  );
  assert.deepEqual(
    await journal.read('batch-1:3:2'),
    record({ tabId: 501 })
  );
});

test('rejects non-exact, non-canonical, or secret-bearing journal records', async () => {
  const session = createSessionArea();
  const journal = createBatchSessionJournal(session.area);

  for (const invalid of [
    record({ requestId: 'forged' }),
    record({ ownerPageTabId: 0 }),
    record({ ownershipEpoch: '' }),
    record({ tabId: 0 }),
    { ...record(), password: 'must-not-enter-session-journal' }
  ]) {
    await assert.rejects(
      journal.write(invalid),
      /invalid_batch_session_journal/
    );
  }
  assert.deepEqual(session.setCalls, []);
});

test('malformed stored journal data is non-authoritative and removal is request-scoped', async () => {
  const session = createSessionArea();
  const journal = createBatchSessionJournal(session.area);
  const key = `${BATCH_SESSION_JOURNAL_PREFIX}batch-1:3:2`;
  session.data[key] = { ...record(), ownershipEpoch: '' };

  assert.equal(await journal.read('batch-1:3:2'), null);

  await journal.remove('batch-1:3:2');
  assert.deepEqual(session.removeCalls, [[key]]);
  assert.equal(Object.hasOwn(session.data, key), false);
});
