import assert from 'node:assert/strict';
import test from 'node:test';

import { createBatchResultStore } from '../lib/batch-result-store.mjs';

function createDelayedStorage(initial = {}) {
  const data = {
    batchResults: [],
    batchReportedUrls: [],
    ...structuredClone(initial)
  };
  let setCalls = 0;
  return {
    data,
    get setCalls() { return setCalls; },
    async get() {
      await new Promise((resolve) => setImmediate(resolve));
      return structuredClone(data);
    },
    async set(values) {
      setCalls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(data, structuredClone(values));
    }
  };
}

test('serializes simultaneous result writes without losing either URL', async () => {
  const storage = createDelayedStorage();
  const store = createBatchResultStore(storage);

  await Promise.all([
    store.save({ batchId: 'a', urlIndex: 0, attempt: 1, result: 'success' }),
    store.save({ batchId: 'a', urlIndex: 1, attempt: 1, result: 'fail' })
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
  await store.save({ batchId: 'a', urlIndex: 0, attempt: 1, result: 'fail' });
  await store.save({ batchId: 'a', urlIndex: 0, attempt: 1, result: 'success' });

  assert.equal(storage.data.batchResults.length, 1);
  assert.equal(storage.data.batchResults[0].result, 'success');
  assert.deepEqual(storage.data.batchReportedUrls, ['a:0:1']);
});

test('keeps retry attempts distinct and preserves their stable error codes', async () => {
  const storage = createDelayedStorage();
  const store = createBatchResultStore(storage);

  await store.save({
    batchId: 'retry-batch',
    urlIndex: 4,
    attempt: 1,
    result: 'fail',
    errorCode: 'submission_uncertain'
  });
  await store.save({
    batchId: 'retry-batch',
    urlIndex: 4,
    attempt: 2,
    result: 'success',
    errorCode: null
  });

  assert.deepEqual(
    storage.data.batchResults.map(
      ({ batchId, urlIndex, attempt, result, errorCode }) => ({
        batchId,
        urlIndex,
        attempt,
        result,
        errorCode
      })
    ),
    [
      {
        batchId: 'retry-batch',
        urlIndex: 4,
        attempt: 1,
        result: 'fail',
        errorCode: 'submission_uncertain'
      },
      {
        batchId: 'retry-batch',
        urlIndex: 4,
        attempt: 2,
        result: 'success',
        errorCode: null
      }
    ]
  );
  assert.deepEqual(storage.data.batchReportedUrls, [
    'retry-batch:4:1',
    'retry-batch:4:2'
  ]);
});

test('rejects incomplete result identities before mutating storage', async () => {
  const invalidMessages = [
    { batchId: '', urlIndex: 0, attempt: 1 },
    { batchId: 42, urlIndex: 0, attempt: 1 },
    { batchId: 'invalid', urlIndex: -1, attempt: 1 },
    { batchId: 'invalid', urlIndex: 0.5, attempt: 1 },
    { batchId: 'invalid', urlIndex: 0 },
    { batchId: 'invalid', urlIndex: 0, attempt: 0 },
    { batchId: 'invalid', urlIndex: 0, attempt: 1.5 }
  ];

  for (const invalidIdentity of invalidMessages) {
    const initial = {
      batchResults: [{
        batchId: 'existing',
        urlIndex: 0,
        attempt: 1,
        result: 'success'
      }],
      batchReportedUrls: ['existing:0:1']
    };
    const storage = createDelayedStorage(initial);
    const store = createBatchResultStore(storage);

    await assert.rejects(
      store.save({ ...invalidIdentity, result: 'fail' }),
      /invalid_batch_result_identity/
    );
    assert.deepEqual(storage.data, initial);
    assert.equal(storage.setCalls, 0);
  }
});

test('a full store ignores a stale attempt before it can evict the newer attempt', async () => {
  const targetResult = {
    batchId: 'capacity-batch',
    urlIndex: 7,
    attempt: 2,
    result: 'success',
    errorCode: null
  };
  const initial = {
    batchResults: [
      targetResult,
      ...Array.from({ length: 99 }, (_, index) => ({
        batchId: 'other-batch',
        urlIndex: index,
        attempt: 1,
        result: 'success'
      }))
    ],
    batchReportedUrls: [
      'capacity-batch:7:2',
      ...Array.from(
        { length: 499 },
        (_, index) => `reported-${index}:0:1`
      )
    ]
  };
  const storage = createDelayedStorage(initial);
  const store = createBatchResultStore(storage);

  await store.save({
    batchId: 'capacity-batch',
    urlIndex: 7,
    attempt: 1,
    result: 'fail',
    errorCode: 'submission_uncertain'
  });

  assert.deepEqual(storage.data, initial);
  assert.equal(storage.setCalls, 0);
});

test('a full store still trims normally for a different task', async () => {
  const initial = {
    batchResults: Array.from({ length: 100 }, (_, index) => ({
      batchId: 'full-batch',
      urlIndex: index,
      attempt: 1,
      result: 'success'
    })),
    batchReportedUrls: Array.from(
      { length: 500 },
      (_, index) => `reported-${index}:0:1`
    )
  };
  const storage = createDelayedStorage(initial);
  const store = createBatchResultStore(storage);

  await store.save({
    batchId: 'new-batch',
    urlIndex: 0,
    attempt: 1,
    result: 'fail'
  });

  assert.equal(storage.data.batchResults.length, 100);
  assert.equal(storage.data.batchResults[0].urlIndex, 1);
  const newestResult = storage.data.batchResults.at(-1);
  assert.deepEqual({
    ...newestResult,
    timestamp: null
  }, {
    batchId: 'new-batch',
    urlIndex: 0,
    attempt: 1,
    url: '',
    result: 'fail',
    aiContent: null,
    errorCode: null,
    errorMessage: null,
    timestamp: null
  });
  assert.equal(typeof newestResult.timestamp, 'number');
  assert.equal(storage.data.batchReportedUrls.length, 500);
  assert.equal(storage.data.batchReportedUrls[0], 'reported-1:0:1');
  assert.equal(storage.data.batchReportedUrls.at(-1), 'new-batch:0:1');
});
