import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBatchSubmitContextStore,
  installBatchSubmitContextListener
} from '../lib/batch-submit-context-store.mjs';

function createStorageArea() {
  const data = {};
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); }
  };
}

test('serializes concurrent contexts by tab id without overwriting', async () => {
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, { now: () => 1000 });

  await Promise.all([
    store.save(11, { batchId: 'a', urlIndex: 0 }),
    store.save(22, { batchId: 'a', urlIndex: 1 })
  ]);

  assert.equal((await store.get(11)).urlIndex, 0);
  assert.equal((await store.get(22)).urlIndex, 1);
  await store.clear(11);
  assert.equal(await store.get(11), null);
  assert.equal((await store.get(22)).urlIndex, 1);
});

test('keeps contexts at ten minutes and removes contexts older than ten minutes', async () => {
  let now = 1000;
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, { now: () => now });
  await store.save(11, { batchId: 'a', urlIndex: 0 });

  now += 10 * 60 * 1000;
  assert.equal((await store.get(11)).urlIndex, 0);

  now += 1;
  assert.equal(await store.get(11), null);
  assert.deepEqual(storage.data.batchSubmitContextsByTab, {});
});

test('can retain an exact pre-submit history context until durable acknowledgement', async () => {
  let now = 1000;
  const storage = createStorageArea();
  const store = createBatchSubmitContextStore(storage, {
    now: () => now,
    maxAgeMs: Number.POSITIVE_INFINITY
  });
  const context = {
    batchId: 'history-batch',
    urlIndex: 4,
    history: {
      commentHtml: 'Exact submitted body',
      historyRevision: {
        capturedAt: 1000,
        recordedAt: 1001,
        sequence: 1,
        id: 'revision-history'
      }
    }
  };

  await store.save(11, context);
  now += 30 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await store.get(11), {
    ...context,
    timestamp: 1000
  });
});

test('listener uses sender tab id and rejects extension-page senders', async () => {
  let listener;
  let tabRemovedListener;
  const chromeApi = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { onRemoved: { addListener(fn) { tabRemovedListener = fn; } } }
  };
  const saved = [];
  const cleared = [];
  const store = {
    async save(tabId, context) { saved.push({ tabId, context }); },
    async clear(tabId) { cleared.push(tabId); }
  };
  installBatchSubmitContextListener(chromeApi, store);

  const valid = await new Promise((resolve) => {
    listener(
      { type: 'BATCH_SAVE_SUBMIT_CONTEXT', tabId: 99, context: { batchId: 'a' } },
      { tab: { id: 42 } },
      resolve
    );
  });
  const invalid = await new Promise((resolve) => {
    listener(
      { type: 'BATCH_SAVE_SUBMIT_CONTEXT', context: { batchId: 'a' } },
      {},
      resolve
    );
  });

  assert.deepEqual(saved, [{ tabId: 42, context: { batchId: 'a' } }]);
  assert.deepEqual(valid, { ok: true });
  assert.deepEqual(invalid, { ok: false, error: 'missing_sender_tab' });
  tabRemovedListener(42);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cleared, [42]);
});
