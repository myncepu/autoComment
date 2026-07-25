import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchResultStore } from '../lib/batch-result-store.mjs';

function createDelayedStorage() {
  const data = { batchResults: [], batchReportedUrls: [] };
  return {
    data,
    async get() {
      await new Promise((resolve) => setImmediate(resolve));
      return structuredClone(data);
    },
    async set(values) {
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(data, structuredClone(values));
    }
  };
}

test('serializes simultaneous result writes without losing either URL', async () => {
  const storage = createDelayedStorage();
  const store = createBatchResultStore(storage);

  await Promise.all([
    store.save({ batchId: 'a', urlIndex: 0, result: 'success' }),
    store.save({ batchId: 'a', urlIndex: 1, result: 'fail' })
  ]);

  assert.deepEqual(
    storage.data.batchResults.map(({ batchId, urlIndex, result }) => ({
      batchId,
      urlIndex,
      result
    })),
    [
      { batchId: 'a', urlIndex: 0, result: 'success' },
      { batchId: 'a', urlIndex: 1, result: 'fail' }
    ]
  );
});

test('updates a duplicate task result instead of appending it', async () => {
  const storage = createDelayedStorage();
  const store = createBatchResultStore(storage);
  await store.save({ batchId: 'a', urlIndex: 0, result: 'fail' });
  await store.save({ batchId: 'a', urlIndex: 0, result: 'success' });

  assert.equal(storage.data.batchResults.length, 1);
  assert.equal(storage.data.batchResults[0].result, 'success');
  assert.deepEqual(storage.data.batchReportedUrls, ['a:0']);
});
